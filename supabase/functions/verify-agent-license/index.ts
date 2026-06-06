/**
 * verify-agent-license
 *
 * 厚生労働省「職業紹介事業者・派遣元事業者検索」サイトに問い合わせ、
 * agent_companies テーブルの license_status を更新する。
 *
 * 実行トリガー:
 *   - cron（毎日 JST 2:00）: verified_at が NULL の会社を最大20件ずつ処理
 *   - 手動呼び出し: POST { domain?: string, batch_size?: number } で即時実行
 *
 * 厚労省エンドポイント（検索フォームの POST 先）:
 *   https://www.hellowork.mhlw.go.jp/kensaku/GICB102010.do
 *   パラメータ例: { screenId: 'GICB102010', action: 'search', jigyosyoName: '<会社名>', searchFlg: '1' }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// 厚労省 検索エンドポイント
const MHLW_SEARCH_URL = 'https://www.hellowork.mhlw.go.jp/kensaku/GICB102010.do'

// 派遣許可番号パターン: 派XX-XXXXXX
const HAKEN_RE = /派\d{2}-\d{6}/g
// 有料職業紹介許可番号パターン: XX-ユXXXXXX
const SHOKAI_RE = /\d{2}-ユ\d{6}/g

interface AgentCompany {
  domain: string
  company_name: string | null
  license_status: string
  verified_at: string | null
}

async function searchMHLW(companyName: string): Promise<{ haken: string[]; shokai: string[] }> {
  const params = new URLSearchParams({
    screenId: 'GICB102010',
    action: 'search',
    jigyosyoName: companyName,
    searchFlg: '1',
    dispNum: '50',
  })

  const res = await fetch(MHLW_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; AkinaviBot/1.0)',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    throw new Error(`MHLW HTTP ${res.status}`)
  }

  const html = await res.text()

  // HTML から許可番号を抽出
  const haken = [...html.matchAll(HAKEN_RE)].map((m) => m[0])
  const shokai = [...html.matchAll(SHOKAI_RE)].map((m) => m[0])

  // 重複排除
  return {
    haken: [...new Set(haken)],
    shokai: [...new Set(shokai)],
  }
}

function determineLicenseStatus(haken: string[], shokai: string[]): string {
  if (haken.length > 0 && shokai.length > 0) return 'both'
  if (haken.length > 0) return 'haken'
  if (shokai.length > 0) return 'shokai'
  return 'none'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  let targetDomain: string | null = null
  let batchSize = 20

  if (req.method === 'POST') {
    try {
      const body = await req.json()
      targetDomain = body.domain ?? null
      batchSize = body.batch_size ?? 20
    } catch {
      // ignore
    }
  }

  // 対象会社を取得
  let query = supabase
    .from('agent_companies')
    .select('domain, company_name, license_status, verified_at')
    .not('company_name', 'is', null)
    .order('first_seen_at', { ascending: true })
    .limit(batchSize)

  if (targetDomain) {
    query = supabase
      .from('agent_companies')
      .select('domain, company_name, license_status, verified_at')
      .eq('domain', targetDomain)
      .limit(1)
  } else {
    // verified_at が NULL（未確認）の会社を優先
    query = supabase
      .from('agent_companies')
      .select('domain, company_name, license_status, verified_at')
      .is('verified_at', null)
      .not('company_name', 'is', null)
      .order('first_seen_at', { ascending: true })
      .limit(batchSize)
  }

  const { data: companies, error: fetchErr } = await query
  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 })
  }

  if (!companies || companies.length === 0) {
    return new Response(JSON.stringify({ message: '確認対象なし（全社確認済みまたは会社名なし）', processed: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const results: { domain: string; status: string; haken: string[]; shokai: string[]; error?: string }[] = []

  for (const company of companies as AgentCompany[]) {
    if (!company.company_name) continue

    // 会社名から「株式会社」等の法人格を除いた名称でも検索精度が上がることがある
    // ここでは原文そのままで検索し、ヒットしなければ法人格なし版も試みる
    const searchName = company.company_name
    const shortName = company.company_name
      .replace(/^(?:株式会社|合同会社|有限会社|一般社団法人|一般財団法人)\s*/, '')
      .replace(/\s*(?:株式会社|合同会社|有限会社)$/, '')
      .trim()

    let haken: string[] = []
    let shokai: string[] = []
    let errMsg: string | undefined

    try {
      const result1 = await searchMHLW(searchName)
      haken = result1.haken
      shokai = result1.shokai

      // ヒットなしかつ法人格なし版が違う場合は再検索
      if (haken.length === 0 && shokai.length === 0 && shortName !== searchName && shortName.length >= 2) {
        await new Promise((r) => setTimeout(r, 500)) // レートリミット対策
        const result2 = await searchMHLW(shortName)
        haken = result2.haken
        shokai = result2.shokai
      }
    } catch (e) {
      errMsg = String(e)
      console.error(`[verify-agent-license] ${company.domain}: ${errMsg}`)
    }

    const status = errMsg ? company.license_status : determineLicenseStatus(haken, shokai)

    // DB 更新
    const updateData: Record<string, unknown> = {
      license_status: status,
      verified_at: errMsg ? null : new Date().toISOString(),
      verified_by: 'cron',
    }
    if (haken.length > 0) updateData.haken_number = haken[0]
    if (shokai.length > 0) updateData.shokai_number = shokai[0]

    const { error: updateErr } = await supabase
      .from('agent_companies')
      .update(updateData)
      .eq('domain', company.domain)

    results.push({ domain: company.domain, status, haken, shokai, error: errMsg })

    // 厚労省へのリクエスト間隔（過負荷防止: 1秒待機）
    if (companies.indexOf(company) < companies.length - 1) {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  console.log(`[verify-agent-license] processed=${results.length} results=${JSON.stringify(results)}`)

  return new Response(
    JSON.stringify({
      processed: results.length,
      results,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
