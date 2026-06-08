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

  // action=health のみ /health、それ以外は /run_quality_check
  const action = new URL(req.url).searchParams.get('action')
  const path = action === 'health' ? '/health' : '/run_quality_check'

  // HF Spaces はスリープ明け起動中（最大60秒）に HTML 404 を返す → リトライで対応
  const MAX_RETRIES = 4
  const RETRY_WAIT_MS = 20000

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${HF_SPACE_URL}${path}`, {
        method: 'GET',
        headers: {
          'x-api-secret': HF_API_SECRET,
          'Accept': 'application/json',
        },
      })
      const contentType = res.headers.get('Content-Type') ?? ''
      const body = await res.text()

      // HTML が返ってきた = HF プロキシが起動待ち中 → リトライ
      if (res.status === 404 && contentType.includes('text/html')) {
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_WAIT_MS))
          continue
        }
        return new Response(JSON.stringify({ ok: false, error: 'HF Space is waking up, retry later' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(body, {
        status: res.status,
        headers: { 'Content-Type': contentType || 'application/json' },
      })
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_WAIT_MS))
        continue
      }
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
})
