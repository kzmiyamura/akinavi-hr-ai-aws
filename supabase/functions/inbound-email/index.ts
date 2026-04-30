// Supabase Edge Function: Make.com (Outlook) → AI解析 → DB保存
// Runtime: Deno / タイムアウト: 最大150秒（Vercel Hobbyの10秒制限を回避）
// POST body (form-urlencoded):
//   type, from, subject, body
//   attachment[data], attachment[mimeType], attachment[name]

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.24.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Attachment {
  data: string
  mimeType: string
  name?: string
}

const SUPPORTED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']

function getEnv(key: string): string {
  const val = Deno.env.get(key)
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`)
  return val
}

/** Microsoft Graph API の from フィールド（JSON文字列の場合も）からメールアドレスを取り出す */
function parseFrom(from: string): string {
  try {
    const obj = JSON.parse(from)
    return obj?.emailAddress?.address ?? from
  } catch {
    return from
  }
}

const AI_MODEL = 'gemini-2.5-flash-lite'

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // form-urlencoded と JSON 両対応
    const contentType = req.headers.get('content-type') ?? ''
    let raw: Record<string, string> = {}

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await req.text()
      const params = new URLSearchParams(text)
      for (const [k, v] of params.entries()) raw[k] = v
    } else {
      raw = await req.json()
    }

    const type: string = raw.type ?? 'candidate'
    const from: string = parseFrom(raw.from ?? '')
    const subject: string = raw.subject ?? ''
    const body: string = raw.body ?? ''

    // 添付ファイルの解決（attachment[data] 形式 → Attachment オブジェクト）
    let attachments: Attachment[] = []
    if (raw['attachment[data]']) {
      attachments = [{
        data: raw['attachment[data]'],
        mimeType: raw['attachment[mimeType]'] ?? '',
        name: raw['attachment[name]'] ?? undefined,
      }]
    } else if (raw.attachmentsJson) {
      try {
        const parsed = JSON.parse(raw.attachmentsJson)
        if (Array.isArray(parsed)) attachments = parsed
      } catch { /* ignore */ }
    }

    console.log('[受信データ]', {
      type, from, subject,
      bodyLength: body.length,
      attachments: attachments.map(a => ({ name: a.name, mimeType: a.mimeType, dataLength: a.data?.length ?? 0 })),
    })

    const supportedAttachments = attachments.filter(a => SUPPORTED_MIME.includes(a.mimeType))
    console.log('[添付フィルター結果]', {
      total: attachments.length,
      supported: supportedAttachments.length,
      filtered: attachments.filter(a => !SUPPORTED_MIME.includes(a.mimeType)).map(a => a.mimeType),
    })

    if (!body.trim() && attachments.length === 0) {
      return new Response(JSON.stringify({ error: 'メール本文と添付ファイルが両方空です' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

    const attachmentNote = supportedAttachments.length > 0
      ? `\n※添付ファイル（${supportedAttachments.map(a => a.name ?? a.mimeType).join('、')}）も含めて解析してください。`
      : ''

    // ── 人材メール ────────────────────────────────────────────
    if (type === 'candidate' || type === 'human') {
      const prompt = `
これは営業担当者が転送・送付した人材紹介メールです。${attachmentNote}
差出人（${from}）は営業担当者であり、候補者本人ではありません。

【重要ルール】
- 本文または添付ファイルに明示的に書かれている情報だけを抽出してください。
- 書かれていない情報は絶対に推測・補完・でっち上げをしないでください。

【氏名の抽出ルール】
- 氏名はPDFや本文の「テキスト内容」から読み取ってください。
- 添付ファイルのファイル名（例: OH_一之江.pdf）は氏名ではありません。絶対に使わないでください。
- 文字化けしている文字列（例：㻻㻴、㼃indows、㻼㻴㻼 等）は正しく読み取れていません。これらを氏名として使わないでください。
- PDFは複数ページある場合があります。必ず全ページを確認してください。
- 学歴/職歴ページ（最終ページ付近）に「フリガナ」「氏名」が明記されている場合、そのページの情報を最優先で使用してください。
- イニシャル（例: O.H.）は氏名ではありません。同じPDF内にフルネームがあればそちらを使ってください。
- 地名・駅名・会社名を氏名と混同しないでください。
- 氏名が本文・添付テキストに明記されていない場合のみ "不明" にしてください。

【メールアドレスの抽出ルール】
- emailは候補者本人のアドレスのみです。
- 差出人（${from}）は営業担当者のため、このアドレスは絶対に入れないでください。
- PDFや本文に候補者のメールアドレスが書かれていなければ必ず null にしてください。

【その他のルール】
- 電話番号も明記されているものだけ。なければ null。
- skillsは重複なしで返してください。表記が異なっても同じ技術（例: JavaScript と Javascript）は1つにまとめ、より一般的な表記に統一してください。
- experienceYearsは職歴の最初の年から現在までの年数を計算してください。明記されていても計算できる場合は計算値を優先してください。
- summaryは具体的な社名・プロジェクト名・実績・受賞歴を必ず含めてください。

件名: ${subject}

抽出項目（JSON形式のみで返してください。前後に余分なテキスト不要）:
- name: string（フルネーム。ファイル名・文字化け文字列は使わない。不明なら "不明"）
- email: string | null（候補者本人のみ。なければ null）
- phone: string | null（明記されたもののみ。なければ null）
- skills: string[]（明記されているもののみ。重複なし。なければ[]）
- experienceYears: number | null（計算または明記された値。なければ null）
- summary: string（職務経歴の概要300字以内。社名・実績・受賞歴を含めること）

本文:
${body.slice(0, 3000)}

JSON:`.trim()

      const { result, durationMs } = await generateJSON(prompt, attachments)
      const analyzed = result as {
        name: string; email: string | null; phone: string | null
        skills: string[]; experienceYears: number | null; summary: string
      }

      console.log('[AI解析結果 candidate]', JSON.stringify(analyzed, null, 2))

      // スキル重複除去（大文字小文字を無視して正規化）
      const skills = Array.from(
        new Map((analyzed.skills ?? []).map((s: string) => [s.toLowerCase(), s])).values()
      )

      // 送信者メールアドレスが混入していたら除去
      const senderEmails = from.split(/[,;]/).map((s: string) => s.trim().toLowerCase())
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
          text: body.slice(0, 5000),
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

      console.log(`[inbound] 人材登録完了: ${data.name}`)
      return new Response(JSON.stringify({ ok: true, type: 'candidate', id: data.id, name: data.name }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 案件メール ────────────────────────────────────────────
    if (type === 'project') {
      const prompt = `
以下のメール本文から案件情報を抽出し、JSON形式のみで返してください。${attachmentNote}

【重要ルール】書かれていない情報は推測せず null または空にしてください。

差出人: ${from}
件名: ${subject}

抽出項目（JSON形式のみで返してください。前後に余分なテキスト不要）:
- title: string（案件名。不明なら "案件"）
- client: string | null（クライアント名。不明なら null）
- description: string（案件概要）
- requiredSkills: string[]（必須スキル。なければ[]）
- budgetMin: number | null（月額・万円。不明ならnull）
- budgetMax: number | null（月額・万円。不明ならnull）

本文:
${body.slice(0, 3000)}

JSON:`.trim()

      const { result, durationMs } = await generateJSON(prompt, attachments)
      const analyzed = result as {
        title: string; client: string | null; description: string
        requiredSkills: string[]; budgetMin: number | null; budgetMax: number | null
      }

      console.log('[AI解析結果 project]', JSON.stringify(analyzed, null, 2))

      const { data, error } = await supabase.from('projects').insert({
        title: analyzed.title ?? '案件',
        client: analyzed.client ?? null,
        description: analyzed.description ?? '',
        required_skills: analyzed.requiredSkills ?? [],
        budget_min: analyzed.budgetMin ?? null,
        budget_max: analyzed.budgetMax ?? null,
        raw_data: {
          text: body.slice(0, 5000),
          from, subject,
          attachmentCount: attachments.length,
          attachmentNames: attachments.map(a => a.name ?? a.mimeType),
          aiAnalysis: analyzed,
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

      console.log(`[inbound] 案件登録完了: ${data.title}`)
      return new Response(JSON.stringify({ ok: true, type: 'project', id: data.id, title: data.title }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: `不明な type: ${type}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[inbound-email] エラー:', message)

    try {
      const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))
      await supabase.from('ai_logs').insert({
        type: 'unknown',
        model: AI_MODEL,
        ai_result: {},
        status: 'error',
        error_message: message,
      })
    } catch { /* ログ保存失敗は握りつぶす */ }

    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})