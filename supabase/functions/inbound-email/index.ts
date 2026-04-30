// Supabase Edge Function: Resend Inbound Webhook → AI解析 → DB保存
// Runtime: Deno

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.24.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Resend Webhook ペイロードを受け取る ──────────────
    const payload = await req.json()

    const from: string = payload.from ?? ''
    const subject: string = payload.subject ?? ''
    const textBody: string = payload.text ?? payload.html ?? ''

    if (!textBody) {
      return new Response(JSON.stringify({ error: 'メール本文が空です' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 2. Gemini で人材情報を解析 ──────────────────────────
    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    if (!geminiKey) throw new Error('GEMINI_API_KEY が設定されていません')

    const genAI = new GoogleGenerativeAI(geminiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const prompt = `
以下のメール本文から人材情報を抽出し、JSON形式のみで返してください。
コードブロックや説明文は不要です。

差出人: ${from}
件名: ${subject}

抽出項目:
- name: string（氏名。不明なら "不明"）
- email: string | null
- phone: string | null
- skills: string[]（スキル・資格・言語等。空なら[]）
- experienceYears: number | null（経験年数。不明ならnull）
- summary: string（200字以内の要約）

本文:
${textBody.slice(0, 3000)}

JSON:`.trim()

    const result = await model.generateContent(prompt)
    const raw = result.response.text()
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const analyzed = JSON.parse(cleaned)

    // email が空なら差出人アドレスをフォールバック
    const emailMatch = from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)
    const email: string | null = analyzed.email || (emailMatch ? emailMatch[0] : null)

    // ── 3. Supabase に upsert ──────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const dbPayload = {
      name: analyzed.name ?? '不明',
      email,
      phone: analyzed.phone ?? null,
      skills: analyzed.skills ?? [],
      experience_years: analyzed.experienceYears ?? null,
      raw_profile: {
        text: textBody.slice(0, 5000),
        summary: analyzed.summary ?? '',
        from,
        subject,
      },
      duplicate_flag: false,
      created_by: 'resend-inbound',
    }

    let dbResult
    if (email) {
      const { data, error } = await supabase
        .from('candidates')
        .upsert(dbPayload, { onConflict: 'email' })
        .select()
        .single()
      if (error) throw new Error(`DB保存エラー: ${error.message}`)
      dbResult = data
    } else {
      const { data, error } = await supabase
        .from('candidates')
        .insert(dbPayload)
        .select()
        .single()
      if (error) throw new Error(`DB保存エラー: ${error.message}`)
      dbResult = data
    }

    console.log(`[inbound-email] 登録完了: ${dbResult.name} (${dbResult.email ?? 'メールなし'})`)

    return new Response(
      JSON.stringify({ ok: true, candidate: { id: dbResult.id, name: dbResult.name, email: dbResult.email } }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[inbound-email] エラー:', message)
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
