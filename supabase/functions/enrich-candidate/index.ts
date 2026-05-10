// Supabase Edge Function: enrich-candidate
// 役割: box-downloader が Google Drive へ転送完了した経歴書ファイルを使い、
//       仮登録済み人材（box_status='pending'）を再解析・更新するバッチ
//
// 実行タイミング: pg_cron により毎日 JST 3:00（UTC 18:00）自動実行
//   ※ box-downloader バッチ（1日1回）の完了後に走るよう時刻を設定すること
//
// スプレッドシート構造（box-downloader と共有）:
//   A列(boxurl)  : Box共有URL（inbound-email が書き込み）
//   B列(driveurl): Google Drive URL（box-downloader が書き込み）
//   C列(実施)    : 空欄 / 成功 / 失敗（box-downloader が書き込み）
//
// 処理フロー:
//   1. スプレッドシートから「実施=成功 & driveurl あり」の行を取得
//   2. candidates テーブルで box_url が一致 & box_status='pending' の人材を検索
//   3. Drive URL からファイルをダウンロード
//   4. Gemini（gemini-2.5-flash）で再解析
//   5. 既存の candidates レコードを UPDATE（スキル・要約・box_status='enriched'）
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GEMINI_API_KEY
//   GOOGLE_SERVICE_ACCOUNT_JSON  : Sheets API 用サービスアカウント JSON
//   BOX_SPREADSHEET_ID           : キュー用スプレッドシートID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.24.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const AI_MODEL = 'gemini-2.5-flash'
const GEMINI_TIMEOUT_MS = 60000

function getEnv(key: string): string {
  const val = Deno.env.get(key)
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`)
  return val
}

// ── Google Sheets API ────────────────────────────────────────────────────────

async function getGoogleAccessToken(
  sa: { client_email: string; private_key: string },
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const encodeB64Url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const headerB64 = encodeB64Url({ alg: 'RS256', typ: 'JWT' })
  const payloadB64 = encodeB64Url({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })
  const signingInput = `${headerB64}.${payloadB64}`

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  const derBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', derBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', privateKey,
    new TextEncoder().encode(signingInput),
  )
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth2:grant_type:jwt-bearer',
      assertion: `${signingInput}.${signatureB64}`,
    }),
  })
  if (!tokenRes.ok) {
    throw new Error(`Google OAuthトークン取得失敗: ${tokenRes.status} ${await tokenRes.text()}`)
  }
  return ((await tokenRes.json()) as { access_token: string }).access_token
}

/** スプレッドシートから「実施=成功 & driveurl あり」の行を取得 */
async function fetchReadyRows(
  spreadsheetId: string,
  accessToken: string,
): Promise<{ boxUrl: string; driveUrl: string; rowIndex: number }[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:C`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Sheets読み込みエラー: ${res.status} ${await res.text()}`)

  const data = (await res.json()) as { values?: string[][] }
  const rows = data.values ?? []

  const result: { boxUrl: string; driveUrl: string; rowIndex: number }[] = []
  for (let i = 1; i < rows.length; i++) { // 0行目はヘッダー
    const boxUrl = (rows[i][0] ?? '').trim()
    const driveUrl = (rows[i][1] ?? '').trim()
    const status = (rows[i][2] ?? '').trim()
    if (boxUrl && driveUrl && status === '成功') {
      result.push({ boxUrl, driveUrl, rowIndex: i })
    }
  }
  return result
}

// ── Drive ファイル取得 ───────────────────────────────────────────────────────

const EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]
const WORD_MIME = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]

function arrayBufferToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

async function extractExcelText(b64: string): Promise<string> {
  const { read: xlsxRead, utils } = await import('npm:xlsx@0.18.5')
  const wb = xlsxRead(b64, { type: 'base64' })
  return wb.SheetNames.map((n: string) =>
    `=== ${n} ===\n${utils.sheet_to_csv(wb.Sheets[n])}`
  ).join('\n\n')
}

async function extractWordText(b64: string): Promise<string> {
  const mammoth = await import('npm:mammoth@1.8.0')
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer
  const result = await mammoth.extractRawText({ arrayBuffer: buf })
  return result.value ?? ''
}

interface DriveFile {
  text?: string
  pdfB64?: string
  filename: string
}

/** Google Drive 共有URLからファイルを取得してテキスト or PDF(base64)を返す */
async function fetchDriveFile(driveUrl: string): Promise<DriveFile | null> {
  // drive.google.com/file/d/<id>... または /uc?id=<id>... 形式からIDを抽出
  const idMatch = driveUrl.match(/\/d\/([a-zA-Z0-9_-]{25,})|[?&]id=([a-zA-Z0-9_-]{25,})/)
  if (!idMatch) {
    console.warn('[Drive] IDを抽出できないURL:', driveUrl)
    return null
  }
  const id = idMatch[1] ?? idMatch[2]
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${id}`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    const res = await fetch(downloadUrl, { signal: controller.signal })
    clearTimeout(timer)

    if (!res.ok) {
      console.warn(`[Drive] 取得失敗 (${res.status}): ${id}`)
      return null
    }

    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    const cd = res.headers.get('content-disposition') ?? ''
    const fnMatch = cd.match(/filename[^;=\n]*=\s*["']?([^"';\n]+)["']?/)
    const filename = fnMatch ? decodeURIComponent(fnMatch[1].trim()) : `file_${id}`

    const isExcel = EXCEL_MIME.includes(ct) || ct.includes('spreadsheet') || ct.includes('excel') || /\.(xlsx?|ods)$/i.test(filename)
    const isWord  = WORD_MIME.includes(ct)  || ct.includes('msword') || ct.includes('wordprocessingml') || /\.(docx?)$/i.test(filename)

    if (ct.includes('pdf')) {
      const b64 = arrayBufferToBase64(await res.arrayBuffer())
      return { pdfB64: b64, filename }
    } else if (ct.includes('text') || ct.includes('csv')) {
      return { text: await res.text(), filename }
    } else if (isExcel) {
      const b64 = arrayBufferToBase64(await res.arrayBuffer())
      return { text: await extractExcelText(b64), filename }
    } else if (isWord) {
      const b64 = arrayBufferToBase64(await res.arrayBuffer())
      return { text: await extractWordText(b64), filename }
    } else {
      console.warn(`[Drive] 未対応タイプ (${ct}) ${filename}`)
      return null
    }
  } catch (e) {
    console.error(`[Drive] fetch例外: ${id}`, e)
    return null
  }
}

// ── Gemini 再解析 ──────────────────────────────────────────────────────────

type CandidateAI = {
  name: string
  email: string | null
  phone: string | null
  skills: string[]
  skillsByCategory: Record<string, string[]>
  roles: string[]
  industries: string[]
  experienceYears: number | null
  summary: string
  nearestStation: string | null
  prefecture: string | null
  availableRegions: string[] | null
  currentWorkLocation: string | null
  remoteAvailable: boolean
}

async function analyzeWithGemini(fileContent: DriveFile, existingSummary: string): Promise<CandidateAI> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL })

  const prompt = `
これはBox経由で取得した経歴書ファイルです。ファイル名: ${fileContent.filename}

【重要ルール】
- ファイルに明示されている情報だけを抽出してください。推測・補完はしないでください。
- 既存の登録情報の補完・更新が目的です。空欄は null にしてください。

【既存の登録サマリー（参考）】
${existingSummary || '（なし）'}

抽出項目（JSON形式のみで返してください）:
- name: string（フルネーム。不明なら "不明"）
- email: string | null
- phone: string | null
- skills: string[]（職種問わず全スキル・ツール。重複なし）
- skillsByCategory: object（14カテゴリ: languages/frameworks/libraries/os/databases/dwh/clouds/infrastructures/tools/methodologies/certifications/design/marketing/others）
- roles: string[]（担当役割・職種）
- industries: string[]（業界経験）
- experienceYears: number | null
- summary: string（職務経歴の概要300字以内。社名・実績を含めること）
- nearestStation: string | null
- prefecture: string | null
- availableRegions: string[] | null
- currentWorkLocation: string | null
- remoteAvailable: boolean

${fileContent.text ? `ファイル内容:\n${fileContent.text.slice(0, 6000)}` : ''}

JSON:`.trim()

  const parts: Parameters<typeof model.generateContent>[0] extends { contents: infer C } ? never : unknown[] = []
  const contentParts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [{ text: prompt }]
  if (fileContent.pdfB64) {
    contentParts.push({ inlineData: { mimeType: 'application/pdf', data: fileContent.pdfB64 } })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
  let result: CandidateAI
  try {
    const response = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] })
    const text = response.response.text()
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/)
    result = JSON.parse(jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text) as CandidateAI
  } finally {
    clearTimeout(timer)
  }
  return result
}

// ── メインハンドラ ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const t0 = Date.now()
  const elapsed = () => `${Date.now() - t0}ms`
  let processed = 0
  let enriched = 0
  let failed = 0

  try {
    const spreadsheetId = getEnv('BOX_SPREADSHEET_ID')
    const saJson = getEnv('GOOGLE_SERVICE_ACCOUNT_JSON')
    const sa = JSON.parse(saJson) as { client_email: string; private_key: string }

    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

    // Google Sheets アクセストークン取得
    console.log('[enrich] Sheets アクセストークン取得中...')
    const accessToken = await getGoogleAccessToken(sa, 'https://www.googleapis.com/auth/spreadsheets')

    // スプレッドシートから処理対象行を取得
    const readyRows = await fetchReadyRows(spreadsheetId, accessToken)
    console.log(`[enrich] 処理対象行: ${readyRows.length}件 elapsed=${elapsed()}`)

    for (const row of readyRows) {
      processed++
      console.log(`[enrich] 処理開始 [${processed}/${readyRows.length}] boxUrl=${row.boxUrl.slice(0, 60)}`)

      try {
        // DB から box_url が一致する pending 人材を検索
        const { data: candidates, error: dbErr } = await supabase
          .from('candidates')
          .select('id, name, raw_profile, box_url, box_status')
          .eq('box_url', row.boxUrl)
          .eq('box_status', 'pending')
          .limit(1)

        if (dbErr) throw new Error(`DB検索エラー: ${dbErr.message}`)
        if (!candidates || candidates.length === 0) {
          console.log(`[enrich] 対応する pending 人材なし（既処理 or 未登録）: ${row.boxUrl.slice(0, 60)}`)
          continue
        }

        const candidate = candidates[0] as {
          id: string
          name: string
          raw_profile: Record<string, unknown>
          box_url: string
          box_status: string
        }
        console.log(`[enrich] 人材発見: ${candidate.name} (${candidate.id})`)

        // Drive からファイル取得
        const fileContent = await fetchDriveFile(row.driveUrl)
        if (!fileContent) {
          console.warn(`[enrich] Driveファイル取得失敗: ${row.driveUrl}`)
          await supabase.from('candidates').update({ box_status: 'failed' }).eq('id', candidate.id)
          failed++
          continue
        }
        console.log(`[enrich] ファイル取得成功: ${fileContent.filename} elapsed=${elapsed()}`)

        // Gemini 再解析
        const existingSummary = String((candidate.raw_profile as Record<string, unknown>)?.summary ?? '')
        const analyzed = await analyzeWithGemini(fileContent, existingSummary)
        console.log(`[enrich] AI解析完了 elapsed=${elapsed()}`)

        // スキル重複除去
        const skills = Array.from(
          new Map(
            (analyzed.skills ?? [])
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0)
              .map((s: string) => [s.toLowerCase(), s])
          ).values()
        )

        // 既存レコードを更新（名前が「不明」の場合は上書きしない）
        const updatePayload: Record<string, unknown> = {
          skills,
          experience_years: typeof analyzed.experienceYears === 'number' ? analyzed.experienceYears : undefined,
          raw_profile: {
            ...(candidate.raw_profile ?? {}),
            summary: analyzed.summary ?? existingSummary,
            skillsByCategory: analyzed.skillsByCategory ?? {},
            roles: analyzed.roles ?? [],
            industries: analyzed.industries ?? [],
            nearestStation: analyzed.nearestStation ?? null,
            prefecture: analyzed.prefecture ?? null,
            availableRegions: analyzed.availableRegions ?? null,
            currentWorkLocation: analyzed.currentWorkLocation ?? null,
            remoteAvailable: analyzed.remoteAvailable ?? false,
            boxDriveFile: fileContent.filename,
            enrichedAt: new Date().toISOString(),
          },
          box_status: 'enriched',
          updated_by: 'enrich-candidate',
        }
        if (analyzed.name && analyzed.name !== '不明') {
          updatePayload.name = analyzed.name
        }
        if (analyzed.email) updatePayload.email = analyzed.email
        if (analyzed.phone) updatePayload.phone = analyzed.phone

        const { error: updateErr } = await supabase
          .from('candidates')
          .update(updatePayload)
          .eq('id', candidate.id)

        if (updateErr) throw new Error(`DB更新エラー: ${updateErr.message}`)

        // candidate_skills も更新
        const validCategories = [
          'languages', 'frameworks', 'libraries', 'os',
          'databases', 'dwh', 'clouds', 'infrastructures',
          'tools', 'methodologies', 'certifications',
          'design', 'marketing', 'others',
        ]
        const skillsPayload: { candidate_id: string; category: string; skill: string }[] = []
        const categoryMap = (analyzed.skillsByCategory ?? {}) as Record<string, string[]>
        for (const category of validCategories) {
          for (const skill of (categoryMap[category] ?? [])) {
            if (skill?.trim()) skillsPayload.push({ candidate_id: candidate.id, category, skill: skill.trim() })
          }
        }
        if (skillsPayload.length > 0) {
          await supabase.from('candidate_skills').delete().eq('candidate_id', candidate.id)
          await supabase.from('candidate_skills').insert(skillsPayload)
          console.log(`[enrich] スキル更新: ${skillsPayload.length}件`)
        }

        enriched++
        console.log(`[enrich] 更新完了: ${candidate.name} elapsed=${elapsed()}`)
      } catch (rowErr) {
        failed++
        console.error(`[enrich] 行処理エラー (boxUrl=${row.boxUrl.slice(0, 60)}):`, rowErr)
      }
    }

    console.log(`[enrich] バッチ完了 processed=${processed} enriched=${enriched} failed=${failed} elapsed=${elapsed()}`)
    return new Response(
      JSON.stringify({ ok: true, processed, enriched, failed, elapsedMs: Date.now() - t0 }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[enrich] FATAL:', e)
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
