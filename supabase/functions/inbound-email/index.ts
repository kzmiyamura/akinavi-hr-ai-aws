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

const AI_MODEL = 'gemini-2.5-flash'

async function generateJSON(
  prompt: string,
  attachments: Attachment[],
): Promise<{ result: unknown; durationMs: number }> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL })

  const parts: object[] = []
  for (const att of attachments) {
    if (att.data && SUPPORTED_MIME.includes(att.mimeType)) {
      parts.push({ inlineData: { data: att.data, mimeType: att.mimeType } })
    }
  }
  parts.push({ text: prompt })

  const start = Date.now()
  const res = await model.generateContent(parts)
  const durationMs = Date.now() - start

  const raw = res.response.text()
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return { result: JSON.parse(cleaned), durationMs }
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
- 氏名が明記されていない場合は "不明" にしてください。
- 地名・駅名・会社名を氏名と混同しないでください。
- PDFは複数ページ・複数書類が含まれる場合があります。全ページを確認し、フルネームが明記されているページの情報を優先してください。
- イニシャル（例: O.H.）は氏名ではありません。同じPDF内にフルネームが書かれているページがあればそちらを使ってください。
- メールアドレスは「xxx@xxx.xxx」の形式で本文・添付に明記されているものだけ入れてください。なければ必ず null。架空のアドレスを作らないでください。
- 差出人（${from}）のメールアドレスは候補者のものではありません。emailフィールドに絶対に入れないでください。
- 電話番号も明記されているものだけ。なければ null。
- skillsは重複なしで返してください。表記が異なっても同じ技術（例: JavaScript と Javascript）は1つにまとめてください。

件名: ${subject}

抽出項目（JSON形式のみで返してください）:
- name: string（氏名。不明なら "不明"）
- email: string | null（本文・添付に明記された候補者本人のメールアドレスのみ。なければ null）
- phone: string | null（明記された電話番号のみ。なければ null）
- skills: string[]（明記されているもののみ。重複なし。なければ[]）
- experienceYears: number | null（明記されていなければ null）
- summary: string（概要200字以内）

本文:
${body.slice(0, 3000)}

JSON:`.trim()

      const { result, durationMs } = await generateJSON(prompt, attachments)
      const analyzed = result as {
        name: string; email: string | null; phone: string | null
        skills: string[]; experienceYears: number | null; summary: string
      }

      console.log('[AI解析結果 candidate]', JSON.stringify(analyzed, null, 2))

      // B: スキル重複除去（大文字小文字を無視して正規化）
      const skills = Array.from(
        new Map((analyzed.skills ?? []).map((s: string) => [s.toLowerCase(), s])).values()
      )

      // A: 送信者メールアドレスが混入していたら除去
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

抽出項目:
- title: string（案件名。不明なら "案件"）
- client: string | null
- description: string
- requiredSkills: string[]（空なら[]）
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
