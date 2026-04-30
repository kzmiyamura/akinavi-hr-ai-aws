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
- 氏名が明記されていない場合は "不明" にしてください。苗字だけ・名前だけの場合もそのまま入れてください。
- 地名・駅名・会社名を氏名と混同しないでください。
- PDFは複数ページ・複数書類が含まれる場合があります。全ページを確認し、フルネームが明記されているページの情報を優先してください。
- イニシャル（例: O.H.）は氏名ではありません。同じPDF内にフルネームが書かれているページがあればそちらを使ってください。
- メールアドレスは「xxx@xxx.xxx」の形式で本文・添付に明記されているものだけ入れてください。書かれていなければ必ず null にしてください。架空のアドレスを作らないでください。
- 差出人（${from}）のメールアドレスは候補者のものではありません。emailフィールドに絶対に入れないでください。
- 電話番号も明記されているものだけ。なければ null。
- skillsは重複なしで返してください。表記が異なっても同じ技術（例: JavaScript と Javascript）は1つにまとめてください。

件名: ${subject}

抽出項目（JSON形式のみで返してください）:
- name: string（氏名。本文・添付に明記されているもの。不明なら "不明"）
- email: string | null（本文・添付に明記された候補者本人のメールアドレスのみ。なければ null）
- phone: string | null（本文・添付に明記された電話番号のみ。なければ null）
- skills: string[]（スキル・資格・言語・経験技術。明記されているもののみ。重複なし。なければ[]）
- experienceYears: number | null（経験年数。明記されていなければ null）
- summary: string（本文・添付の内容をもとにした概要。200字以内）

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
${String(body).slice(0, 3000)}

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
          text: String(body).slice(0, 5000),
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
