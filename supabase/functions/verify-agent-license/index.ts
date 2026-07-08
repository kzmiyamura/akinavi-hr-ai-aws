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
  haken_number: string | null
  license_status: string
  verified_at: string | null
}

const MHLW_INIT_URL = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** initDisp でセッション（JSESSIONID）を確立する。会社名検索・番号検索の両方で共通利用 */
async function establishMHLWSession(): Promise<string> {
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
  const setCookie = initRes.headers.get('set-cookie') ?? ''
  const jsessionMatch = setCookie.match(/JSESSIONID=([^;]+)/)
  return jsessionMatch ? jsessionMatch[1] : ''
}

/**
 * 許可番号（例: 派13-318631）で直接検索し、正式な事業主名称と詳細ページURLを取得する。
 * メール署名から抽出した会社名は抽出バグ・表記ゆれで検索にヒットしないことがあるが、
 * 番号自体は独立した別ロジック（extractLicenseNumbers）で正しく取れているケースが多いため、
 * 番号がある場合は会社名検索より先にこちらを優先して試すべき。
 */
async function searchMHLWByNumber(hakenNumber: string): Promise<{ companyName: string | null; hakenDetailUrl: string | null }> {
  const m = hakenNumber.match(/^派(\d{2})-(\d{6})$/)
  if (!m) return { companyName: null, hakenDetailUrl: null }
  const jsessionId = await establishMHLWSession()

  const searchParams = new URLSearchParams({
    screenId: 'GICB102010',
    action: 'search',
    cbZenkoku: '1',
    ucKyokatodokedeNo1: '1', // 「派」区分
    txtKyokatodokedeNo2: m[1],
    txtKyokatodokedeNo3: m[2],
    'nm_btnSearch.x': '1',
    'nm_btnSearch.y': '1',
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
  if (!searchRes.ok) throw new Error(`MHLW number search HTTP ${searchRes.status}`)
  const html = await searchRes.text()

  const nameMatch = html.match(/id="ID_lbJigyonushiName"[^>]*>([^<]+)</)
  const companyName = nameMatch ? nameMatch[1].trim() : null

  const detailLinkMatch = html.match(/id="ID_linkKyokatodokedeNo"[^>]*href="([^"]+)"/)
  const hakenDetailUrl = detailLinkMatch
    ? new URL(detailLinkMatch[1].replace(/&amp;/g, '&'), MHLW_SEARCH_URL).toString()
    : null

  return { companyName, hakenDetailUrl }
}

/** 厚労省サイトでセッション確立 → 会社名検索 → 許可番号抽出 */
async function searchMHLW(companyName: string): Promise<{ haken: string[]; shokai: string[]; hakenDetailUrl: string | null }> {
  const jsessionId = await establishMHLWSession()

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
    return { haken: [], shokai: [], hakenDetailUrl: null }
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

  // 詳細ページへの完全なリンク（<a id="ID_linkKyokatodokedeNo" href="...detkey_Detail=...">）を抽出。
  // 末尾の事業所インデックス（,0 / ,1 等）は同一許可番号を持つ複数事業所のどれを表示するかを
  // 示す値でサイト側が生成した値でないと不定のため、推測せずサイトのHTMLからそのまま取得する。
  const detailLinkMatch = html.match(/id="ID_linkKyokatodokedeNo"[^>]*href="([^"]+)"/)
  const hakenDetailUrl = detailLinkMatch
    ? new URL(detailLinkMatch[1].replace(/&amp;/g, '&'), MHLW_SEARCH_URL).toString()
    : null

  return {
    haken: [...new Set(hakenFallback)],
    shokai: [...new Set(shokaiAll)],
    hakenDetailUrl,
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
    .select('domain, company_name, haken_number, license_status, verified_at')
    .not('company_name', 'is', null)
    .order('first_seen_at', { ascending: true })
    .limit(batchSize)

  if (targetDomain) {
    query = supabase
      .from('agent_companies')
      .select('domain, company_name, haken_number, license_status, verified_at')
      .eq('domain', targetDomain)
      .limit(1)
  } else {
    // verified_at が NULL（未確認）の会社を優先
    query = supabase
      .from('agent_companies')
      .select('domain, company_name, haken_number, license_status, verified_at')
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

    let haken: string[] = company.haken_number ? [company.haken_number] : []
    let shokai: string[] = []
    let hakenDetailUrl: string | null = null
    let correctedCompanyName: string | null = null
    let errMsg: string | undefined

    try {
      // 既に許可番号がある場合は番号検索を最優先で試す。会社名抽出の誤り・表記ゆれの
      // 影響を受けず、番号自体が正しければ確実にヒットする（同時に正式な会社名も取得でき、
      // 会社名抽出バグの補正にもなる）。
      if (company.haken_number) {
        const byNumber = await searchMHLWByNumber(company.haken_number)
        hakenDetailUrl = byNumber.hakenDetailUrl
        if (byNumber.companyName) correctedCompanyName = byNumber.companyName
        if (byNumber.hakenDetailUrl) await new Promise((r) => setTimeout(r, 500)) // レートリミット対策
      }

      if (!hakenDetailUrl) {
        const result1 = await searchMHLW(searchName)
        haken = result1.haken
        shokai = result1.shokai
        hakenDetailUrl = result1.hakenDetailUrl

        // ヒットなしかつ法人格なし版が違う場合は再検索
        if (haken.length === 0 && shokai.length === 0 && shortName !== searchName && shortName.length >= 2) {
          await new Promise((r) => setTimeout(r, 500)) // レートリミット対策
          const result2 = await searchMHLW(shortName)
          haken = result2.haken
          shokai = result2.shokai
          hakenDetailUrl = result2.hakenDetailUrl
        }
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
    if (hakenDetailUrl) updateData.haken_detail_url = hakenDetailUrl
    // 番号検索で正式な事業主名称が取れた場合、メール抽出由来の壊れた会社名を補正する
    if (correctedCompanyName) updateData.company_name = correctedCompanyName

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
