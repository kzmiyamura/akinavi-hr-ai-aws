// Supabase Edge Function: match-score
// 人材×案件のマッチングスコアをGroq（無料）またはGemini（フォールバック）で算出

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const GROQ_MODEL_PRIMARY = 'llama-3.3-70b-versatile'  // 100,000 TPD
const GROQ_MODEL_FALLBACK = 'llama-3.1-8b-instant'    // 500,000 TPD
const GEMINI_MODEL = 'gemini-2.5-flash'

function buildPrompt(candidate: unknown, project: unknown): string {
  return `人材と案件のマッチング評価。1行のコンパクトJSONのみ返す。改行・インデント不要。説明文不要。

人材: ${JSON.stringify(candidate)}
案件: ${JSON.stringify(project)}

出力形式（1行・改行なし）:
{"score":数値0-100,"summary":"理由100字以内","duplicateSuspected":false}`.trim()
}

async function callGroq(key: string, prompt: string, model: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.choices[0].message.content as string
}

async function callGemini(prompt: string): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) throw new Error('GEMINI_API_KEY not set')

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1200 },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.candidates[0].content.parts[0].text as string
}

function parseResult(text: string): { score: number; summary: string; duplicateSuspected: boolean } {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`JSONが見つかりません: ${cleaned.slice(0, 100)}`)
  const parsed = JSON.parse(m[0])
  return {
    score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.score))) : 0,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    duplicateSuspected: parsed.duplicateSuspected === true,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { candidateProfile, projectRequirements } = await req.json()
    if (!candidateProfile || !projectRequirements) {
      return new Response(JSON.stringify({ error: 'candidateProfile と projectRequirements が必要です' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const prompt = buildPrompt(candidateProfile, projectRequirements)
    const groqKey = Deno.env.get('GROQ_API_KEY')

    let raw: string
    let usedModel = GEMINI_MODEL

    if (groqKey) {
      try {
        raw = await callGroq(groqKey, prompt, GROQ_MODEL_FALLBACK)
        usedModel = GROQ_MODEL_FALLBACK
      } catch (e) {
        console.warn(`[match-score] Groq 8B失敗、70Bへ: ${e}`)
        try {
          raw = await callGroq(groqKey, prompt, GROQ_MODEL_PRIMARY)
          usedModel = GROQ_MODEL_PRIMARY
        } catch (e2) {
          console.warn(`[match-score] Groq 70B失敗、Geminiへ: ${e2}`)
          raw = await callGemini(prompt)
        }
      }
    } else {
      raw = await callGemini(prompt)
    }

    const result = parseResult(raw)
    console.log(`[match-score] ${usedModel} score=${result.score}`)

    return new Response(
      JSON.stringify({ ...result, usedModel }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[match-score] エラー:', String(e))
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
