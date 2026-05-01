// Vercel Serverless Function: Make.com → AI解析 → Supabase保存
// POST /api/analyze
// Body (form-urlencoded):
//   type, from, subject, body
//   attachmentsJson: JSON文字列 [{data, mimeType, name?}, ...]  ← 複数添付対応
//   attachment[data], attachment[mimeType], attachment[name]    ← 旧形式（後方互換）

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createClient } from '@supabase/supabase-js'

interface Attachment {
  data: string
  mimeType: string
  name?: string
}

// Gemini が inlineData で受け付ける MIME タイプ
const SUPPORTED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']

function getEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`)
  return val
}

function parseIsoDateOnly(value: unknown): string | null {
  if (value == null || typeof value !== 'string') return null
  const s = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = Date.parse(`${s}T12:00:00`)
  if (Number.isNaN(t)) return null
  return s
}

function parseOptionalInt(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10)
  if (!Number.isFinite(n)) return null
  const x = Math.trunc(n)
  if (x < min || x > max) return null
  return x
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  return s.length > 0 ? s : null
}

const AI_MODEL = 'gemini-2.5-flash'

/** テキスト + 複数添付ファイル（任意）を Gemini で解析して JSON を返す */
async function generateJSON(
  prompt: string,
  attachments: Attachment[],
  maxRetries = 2,
): Promise<{ result: unknown; durationMs: number }> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL, generationConfig: { temperature: 0 } })

  const parts: object[] = []
  for (const att of attachments) {
    if (att.data && SUPPORTED_MIME.includes(att.mimeType)) {
      parts.push({ inlineData: { data: att.data, mimeType: att.mimeType } })
    }
  }
  parts.push({ text: prompt })

  const start = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await model.generateContent(parts)
      const durationMs = Date.now() - start
      const raw = res.response.text()
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const result = JSON.parse(cleaned)

      // スキルと概要が両方空の場合はリトライ
      const isEmpty = Array.isArray((result as any).skills) && (result as any).skills.length === 0
        && !(result as any).summary
      if (isEmpty && attempt < maxRetries) {
        console.warn(`[generateJSON] attempt ${attempt}: skills/summary が空のためリトライ`)
        continue
      }

      return { result, durationMs }
    } catch (e) {
      lastError = e
      if (attempt < maxRetries) {
        console.warn(`[generateJSON] attempt ${attempt}: エラーのためリトライ`, e)
      }
    }
  }
  throw lastError
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const raw = req.body ?? {}

    const type: string = String(raw.type ?? 'candidate')
    const from: string = String(raw.from ?? '')
    const subject: string = String(raw.subject ?? '')
    const body: string = String(raw.body ?? '')

    // 複数添付（attachmentsJson）→ 旧形式（attachment[data]）→ raw.attachment の順で解決
    let attachments: Attachment[] = []

    if (raw.attachmentsJson) {
      try {
        const parsed = JSON.parse(String(raw.attachmentsJson))
        if (Array.isArray(parsed)) attachments = parsed
      } catch { /* パース失敗時は空配列のまま */ }
    }

    if (attachments.length === 0 && raw['attachment[data]']) {
      attachments = [{
        data: String(raw['attachment[data]']),
        mimeType: String(raw['attachment[mimeType]'] ?? ''),
        name: raw['attachment[name]'] ? String(raw['attachment[name]']) : undefined,
      }]
    }

    if (attachments.length === 0 && raw.attachment?.data) {
      attachments = [raw.attachment as Attachment]
    }

    // 受信した添付情報をログ出力（データ本体は長いので除く）
    console.log('[受信データ]', {
      type, from, subject,
      bodyLength: String(body).length,
      attachments: attachments.map(a => ({
        name: a.name,
        mimeType: a.mimeType,
        dataLength: a.data?.length ?? 0,
      })),
    })

    if (!String(body).trim() && attachments.length === 0) {
      return res.status(400).json({ error: 'メール本文と添付ファイルが両方空です' })
    }

    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

    const supportedAttachments = attachments.filter(a => SUPPORTED_MIME.includes(a.mimeType))
    console.log('[添付フィルター結果]', {
      total: attachments.length,
      supported: supportedAttachments.length,
      filtered: attachments.filter(a => !SUPPORTED_MIME.includes(a.mimeType)).map(a => a.mimeType),
    })
    const attachmentNote = supportedAttachments.length > 0
      ? `\n※添付ファイル（${supportedAttachments.map(a => a.name ?? a.mimeType).join('、')}）も含めて解析してください。`
      : ''

    // ── 人材メール解析 ────────────────────────────────────────
    if (type === 'candidate' || type === 'human') {
      const prompt = `
これは営業担当者が転送・送付した人材紹介メールです。${attachmentNote}
差出人（${from}）は営業担当者であり、候補者本人ではありません。

【重要ルール】
- 本文または添付ファイルに明示的に書かれている情報だけを抽出してください。
- 書かれていない情報は絶対に推測・補完・でっち上げをしないでください。
- 氏名はPDFや本文の「テキスト内容」から読み取ってください。添付ファイルのファイル名（例: OH_一之江.pdf）は氏名ではありません。絶対にファイル名を氏名として使わないでください。
- 氏名が本文・添付テキストに明記されていない場合のみ "不明" にしてください。
- イニシャル（例: O.H.）は氏名ではありません。同じPDF内にフルネームが書かれているページがあればそちらを使ってください。
- 地名・駅名・会社名を氏名と混同しないでください。
- PDFは複数ページある場合があります。全ページを確認し、フルネームが明記されているページの情報を優先してください。
- emailは候補者本人のアドレスのみです。差出人（${from}）は営業担当者のため、このアドレスは絶対に入れないでください。PDFや本文に候補者のメールアドレスが書かれていなければ必ず null にしてください。
- 電話番号も明記されているものだけ。なければ null。
- skillsは重複なしで返してください。表記が異なっても同じ技術（例: JavaScript と Javascript）は1つにまとめてください。

件名: ${subject}

抽出項目（JSON形式のみで返してください）:
- name: string（PDFや本文テキストに明記された氏名。ファイル名は使わない。不明なら "不明"）
- email: string | null（候補者本人のメールアドレスのみ。差出人アドレスは入れない。なければ null）
- phone: string | null（本文・添付に明記された電話番号のみ。なければ null）
- skills: string[]（スキル・資格・言語・経験技術。明記されているもののみ。重複なし。なければ[]）
- experienceYears: number | null（経験年数。明記されていなければ null）
- summary: string（職務経歴の概要300字以内。具体的な社名・プロジェクト・実績・受賞歴があれば必ず含めること）

本文:
${String(body).slice(0, 3000)}

JSON:`.trim()

      const { result, durationMs } = await generateJSON(prompt, attachments)
      const analyzed = result as {
        name: string; email: string | null; phone: string | null
        skills: string[]; experienceYears: number | null; summary: string
      }

      console.log('[AI解析結果 candidate]', JSON.stringify(analyzed, null, 2))

      // B: スキル重複除去（大文字小文字を無視して正規化）
      const skills = Array.from(
        new Map((analyzed.skills ?? []).map(s => [s.toLowerCase(), s])).values()
      )

      // A: 送信者メールアドレスが混入していたら除去
      const senderEmails = from.split(/[,;]/).map(s => s.trim().toLowerCase())
      const email = analyzed.email && !senderEmails.includes(analyzed.email.toLowerCase())
        ? analyzed.email
        : null

      const dbPayload = {
        name: analyzed.name ?? '不明',
        email,
        phone: analyzed.phone ?? null,
        skills,
        experience_years: analyzed.experienceYears ?? null,
        raw_profile: {
          text: String(body).slice(0, 5000),
          summary: analyzed.summary ?? '',
          from, subject,
          attachmentCount: attachments.length,
          attachmentNames: attachments.map(a => a.name ?? a.mimeType),
          aiAnalysis: analyzed,
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
      }

      const { data, error } = email
        ? await supabase.from('candidates').upsert(dbPayload, { onConflict: 'email' }).select().single()
        : await supabase.from('candidates').insert(dbPayload).select().single()

      if (error) throw new Error(`候補者保存エラー: ${error.message}`)

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'candidate',
        model: AI_MODEL,
        from_address: from,
        subject,
        ai_result: analyzed,
        prompt_length: prompt.length,
        status: 'success',
        duration_ms: durationMs,
        linked_id: data.id,
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      return res.status(200).json({ ok: true, type: 'candidate', id: data.id, name: data.name })
    }

    // ── 案件メール解析 ────────────────────────────────────────
    // 本番は Supabase Edge `inbound-email` 推奨。ここは後方互換用。
    if (type === 'project') {
      const prompt = `
これは営業担当者が転送・送付した業務委託・派遣・開発案件などの依頼メールです。${attachmentNote}
差出人（${from}）は営業または元請け担当者であることがあります。本文・添付に書かれた内容だけを根拠に抽出してください。

【重要ルール】
- 明示されている情報だけを抽出し、推測・でっち上げはしないでください。
- requiredSkills には「必須」相当のみ。尚可・歓迎は niceToHaveSkills に。
- スキル列の区切り（「/」「・」,「、」）は分割し、重複を除き表記を統一（例: Javascript→JavaScript）。
- budgetMin / budgetMax は月額万円。曖昧なら null。
- startDate / endDate は YYYY-MM-DD のみ。確定日がなければ null。
- headcount / settlementMin / settlementMax / workLocation 等は Edge `inbound-email` と同様のルール。

件名: ${subject}

抽出項目（JSON形式のみ）:
- title: string（不明なら "案件"）
- client: string | null
- description: string
- requiredSkills: string[]（必須。空なら[]）
- niceToHaveSkills: string[]（尚可。空なら[]）
- budgetMin: number | null
- budgetMax: number | null
- startDate: string | null
- endDate: string | null
- workLocation: string | null
- remotePolicy: string | null
- contractType: string | null
- headcount: number | null
- workload: string | null
- settlementMin: number | null
- settlementMax: number | null
- roleSummary: string | null
- industry: string | null

本文:
${String(body).slice(0, 3000)}

JSON:`.trim()

      const { result, durationMs } = await generateJSON(prompt, attachments)
      const analyzed = result as {
        title: string
        client: string | null
        description: string
        requiredSkills: string[]
        niceToHaveSkills?: string[]
        budgetMin: number | null
        budgetMax: number | null
        startDate?: string | null
        endDate?: string | null
        workLocation?: string | null
        remotePolicy?: string | null
        contractType?: string | null
        headcount?: number | null
        workload?: string | null
        settlementMin?: number | null
        settlementMax?: number | null
        roleSummary?: string | null
        industry?: string | null
      }

      const requiredSkills = Array.from(
        new Map(
          (analyzed.requiredSkills ?? [])
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0)
            .map((s: string) => [s.toLowerCase(), s]),
        ).values(),
      )
      const niceToHaveSkills = Array.from(
        new Map(
          (analyzed.niceToHaveSkills ?? [])
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0)
            .map((s: string) => [s.toLowerCase(), s]),
        ).values(),
      )

      console.log('[AI解析結果 project]', JSON.stringify(analyzed, null, 2))

      const headcount = parseOptionalInt(analyzed.headcount, 1, 500)
      const settlementMin = parseOptionalInt(analyzed.settlementMin, 0, 744)
      const settlementMax = parseOptionalInt(analyzed.settlementMax, 0, 744)

      const { data, error } = await supabase.from('projects').insert({
        title: analyzed.title ?? '案件',
        client: analyzed.client ?? null,
        description: analyzed.description ?? '',
        required_skills: requiredSkills,
        budget_min: analyzed.budgetMin ?? null,
        budget_max: analyzed.budgetMax ?? null,
        start_date: parseIsoDateOnly(analyzed.startDate),
        end_date: parseIsoDateOnly(analyzed.endDate),
        work_location: strOrNull(analyzed.workLocation),
        remote_policy: strOrNull(analyzed.remotePolicy),
        contract_type: strOrNull(analyzed.contractType),
        headcount,
        workload: strOrNull(analyzed.workload),
        settlement_min: settlementMin,
        settlement_max: settlementMax,
        role_summary: strOrNull(analyzed.roleSummary),
        industry: strOrNull(analyzed.industry),
        raw_data: {
          text: String(body).slice(0, 5000),
          from,
          subject,
          attachmentCount: attachments.length,
          attachmentNames: attachments.map((a) => a.name ?? a.mimeType),
          niceToHaveSkills,
          aiAnalysis: { ...analyzed, requiredSkills, niceToHaveSkills },
        },
        created_by: 'make-inbound',
      }).select().single()

      if (error) throw new Error(`案件保存エラー: ${error.message}`)

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'project',
        model: AI_MODEL,
        from_address: from,
        subject,
        ai_result: analyzed,
        prompt_length: prompt.length,
        status: 'success',
        duration_ms: durationMs,
        linked_id: data.id,
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      return res.status(200).json({ ok: true, type: 'project', id: data.id, title: data.title })
    }

    return res.status(400).json({ error: `不明な type: ${type}` })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/analyze] エラー:', message)

    try {
      const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))
      const raw = req.body ?? {}
      await supabase.from('ai_logs').insert({
        type: String(raw.type ?? 'unknown'),
        model: AI_MODEL,
        from_address: String(raw.from ?? ''),
        subject: String(raw.subject ?? ''),
        ai_result: {},
        status: 'error',
        error_message: message,
      })
    } catch { /* ログ保存失敗は握りつぶす */ }

    return res.status(500).json({ ok: false, error: message })
  }
}
