// hf-proxy: HF Spaces への中継 Edge Function
// pg_cron は Supabase の IP から直接 HF を叩けないため、
// Deno Deploy (Edge Function) 経由でプロキシする

const HF_SPACE_URL = 'https://kzmiyamura-akinavi-quality-check.hf.space'
const HF_API_SECRET = Deno.env.get('HF_API_SECRET') ?? ''

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' },
    })
  }

  const path = new URL(req.url).searchParams.get('path') ?? '/run_quality_check'

  try {
    const res = await fetch(`${HF_SPACE_URL}${path}`, {
      method: 'GET',
      headers: { 'x-api-secret': HF_API_SECRET },
    })
    const body = await res.text()
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
