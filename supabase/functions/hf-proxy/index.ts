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

  // HF Spaces はコールドスタート時（LLMロード含む）に時間がかかる
  // 各フェッチに 25s タイムアウトをつけ、4回リトライ（合計最大 ~120s < 150s Supabase制限）
  const MAX_RETRIES = 4
  const FETCH_TIMEOUT_MS = 25000
  const RETRY_WAIT_MS = 5000

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`${HF_SPACE_URL}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'x-api-secret': HF_API_SECRET,
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': 'https://huggingface.co/',
        },
      })
      clearTimeout(timer)
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
      clearTimeout(timer)
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
