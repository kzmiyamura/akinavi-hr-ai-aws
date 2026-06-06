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
 *   https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do
 *   パラメータ例: { screenId: 'GICB102010', action: 'search', jigyosyoName: '<会社名>', searchFlg: '1' }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// 厚労省「人材サービス総合サイト」派遣元事業者検索エンドポイント
// 正式URL確認済み (2026-06-06): https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do
const MHLW_SEARCH_URL = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do'

// 派遣許可番号パターン: 派13-303936 形式（HTML内 lbKyokatodokedeNo spanから抽出）
const HAKEN_RE = /派\d{2}-\d{6}/g
// 有料職業紹介許可番号パターン: 13-ユ303936 形式
const SHOKAI_RE = /\d{2}-ユ\d{6}/g

interface AgentCompany {
  domain: string
  company_name: string | null
  license_status: string
  verified_at: string | null
}

const MHLW_INIT_URL = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do'

/** 厚労省サイトでセッション確立 → 会社名検索 → 許可番号抽出 */
async function searchMHLW(companyName: string): Promise<{ haken: string[]; shokai: string[] }> {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

  // Step1: initDisp でセッション確立
  const initRes = await fetch(MHLW_INIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'screenId=GICB102010&action=initDisp',
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  })
  if (!initRes.ok) throw new Error(`MHLW init HTTP ${initRes.status}`)

  // Cookieを取得
  const setCookie = initRes.headers.get('set-cookie') ?? ''
  const jsessionMatch = setCookie.match(/JSESSIONID=([^;]+)/)
  const jsessionId = jsessionMatch ? jsessionMatch[1] : ''

  // Step2: 全国・会社名で検索
  const searchParams = new URLSearchParams({
    screenId: 'GICB102010',
    action: 'search',
    cbZenkoku: '1',           // 全国チェック（必須: 都道府県指定）
    txtJigyonushiName: companyName,
    cbJigyonushiName: '1',    // 部分一致
    txtJigyoshoName: '',
    cbJigyoshoName: '1',
    'nm_btnSearch.x': '1',
    'nm_btnSearch.y': '1',
    hfScrollTop: '0',
    maba_vrbs: '',
    codeAssistType: '',
    codeAssistKind: '',
    codeAssistCode: '',
    codeAssistItemCode: '',
    codeAssistItemName: '',
    codeAssistDivide: '',
  })

  const searchRes = await fetch(MHLW_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Referer': MHLW_INIT_URL,
      ...(jsessionId ? { 'Cookie': `JSESSIONID=${jsessionId}` } : {}),
    },
    body: searchParams.toString(),
    signal: AbortSignal.timeout(15000),
  })

  if (!searchRes.ok) throw new Error(`MHLW search HTTP ${searchRes.status}`)

  const html = await searchRes.text()

  // 検索結果0件判定（「検索結果に表示されない場合」のメッセージが出ていたら 0 件）
  if (html.includes('検索結果に表示されない場合') && !html.includes('lbKyokatodokedeNo')) {
    return { haken: [], shokai: [] }
  }

  // HTML から許可番号を抽出（例: 派13-303936）
  // 既知の不正値（フォーム例示・検索ノイズ）を除外するセット
  const HAKEN_FAKE = new Set(['派01-000001', '派13-307608'])
  const isValidHaken = (s: string) => /^派\d{2}-\d{6}$/.test(s) && !HAKEN_FAKE.has(s)

  // lbKyokatodokedeNo span から抽出
  const spanMatches = [...html.matchAll(/lbKyokatodokedeNo[^>]*>([^<]+)</g)].map(m => m[1].trim())
  const hakenFromSpan = spanMatches.filter(isValidHaken)
  const shokaiFromSpan = spanMatches.filter(s => /^\d{2}-ユ\d{6}$/.test(s))

  // spanで取れない場合はHTML全体から抽出
  const hakenFallback = hakenFromSpan.length > 0 ? hakenFromSpan :
    [...html.matchAll(HAKEN_RE)].map(m => m[0]).filter(isValidHaken)
  const shokaiAll = shokaiFromSpan.length > 0 ? shokaiFromSpan :
    [...html.matchAll(SHOKAI_RE)].map(m => m[0])

  return {
    haken: [...new Set(hakenFallback)],
    shokai: [...new Set(shokaiAll)],
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
