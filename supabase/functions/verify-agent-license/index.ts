/**
 * verify-agent-license
 *
 * 厚生労働省「職業紹介事業者・派遣元事業者検索」サイトに問い合わせ、
 * agent_companies テーブルの license_status を更新する。
 *
 * 実行トリガー:
 *   - cron（毎日 JST 2:00）: 未確認の会社と、照合できずのまま30日経った会社を最大20件ずつ処理
 *   - 手動呼び出し: POST { domain?: string, batch_size?: number } で即時実行
 *
 * 2026-09-12 に直した2つの取り違え（どちらも「引けなかった」を事実として書いていた）:
 *   1. 検索キーが半角のままだった。サイトは事業主名を全角で持つ（「株式会社ＧＦＤ」）ため、
 *      英字を含む社名は 0 件になる。searchVariants で全角版・法人格なし版も試す。
 *   2. 0 件を 'none'（免許なし）と記録していた。正しくは 'notfound'（照合できず）。
 *      赤字の「免許なし」は営業が取引可否を判断する表示で、しかも p_require_haken の
 *      絞り込みにも効く（該当社の人材がマッチングから丸ごと消える）。
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

// 「照合できず」で終わった会社を、何日後に引き直すか。
// 許可を取ったばかりの会社・こちらの社名抽出が後から直った会社を拾い直すため。
const RETRY_AFTER_DAYS = 30

// 許可番号のパターンは parseSearchResults 内の isValidNumber を正とする
// （派13-303936 / 13-ユ303936）。HTML 全体から拾う旧フォールバックは、
// 番号と事業主名の対応が取れず他社の番号を貼る事故のもとだったので消した。

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

/** 厚労省サイトでセッション確立 → 会社名検索 → 1件ずつ（許可番号・事業主名・詳細URL）を返す */
async function searchMHLW(companyName: string): Promise<{ number: string; name: string; detailUrl: string | null }[]> {
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

  return parseSearchResults(html).map((e) => ({
    ...e,
    // 詳細ページのリンクは相対パス。末尾の事業所インデックス（,0 / ,1）は
    // サイトが生成した値でないと不定なので、推測せずそのまま使う
    detailUrl: e.detailUrl ? new URL(e.detailUrl, MHLW_SEARCH_URL).toString() : null,
  }))
}

/**
 * 検索結果 HTML を「1件＝許可番号＋事業主名＋詳細リンク」に分解する。
 *
 * 番号と社名を別々に集めていたため、複数ヒットしたときに **どの社名の番号か**が
 * 失われていた。結果ページは1行につき（詳細リンク → 許可番号 → 事業主名）の順に並ぶので、
 * 事業主名の直前にある番号・リンクをその行のものとして組み直す。
 * 同じ行がレイアウト違いで2度出るため、(番号, 社名) で重複を落とす。
 */
export function parseSearchResults(html: string): { number: string; name: string; detailUrl: string | null }[] {
  // 既知の不正値（フォーム例示・検索ノイズとして HTML に常駐する番号）
  const HAKEN_FAKE = new Set(['派01-000001', '派13-307608'])
  const isValidNumber = (s: string) =>
    (/^派\d{2}-\d{6}$/.test(s) && !HAKEN_FAKE.has(s)) || /^\d{2}-ユ\d{6}$/.test(s)

  const marks: { at: number; kind: string; value: string }[] = []
  for (const m of html.matchAll(/id="ID_linkKyokatodokedeNo"[^>]*href="([^"]+)"/g)) {
    marks.push({ at: m.index ?? 0, kind: 'link', value: m[1].replace(/&amp;/g, '&') })
  }
  for (const m of html.matchAll(/lbKyokatodokedeNo[^>]*>([^<]+)</g)) {
    marks.push({ at: m.index ?? 0, kind: 'no', value: m[1].trim() })
  }
  for (const m of html.matchAll(/id="ID_lbJigyonushiName"[^>]*>([^<]+)</g)) {
    marks.push({ at: m.index ?? 0, kind: 'name', value: m[1].replace(/&#xa0;|&nbsp;/g, ' ').trim() })
  }
  marks.sort((a, b) => a.at - b.at)

  const out: { number: string; name: string; detailUrl: string | null }[] = []
  const seen = new Set<string>()
  let lastNo: string | null = null
  let lastLink: string | null = null
  for (const mk of marks) {
    if (mk.kind === 'link') lastLink = mk.value
    else if (mk.kind === 'no') { if (isValidNumber(mk.value)) lastNo = mk.value }
    else if (mk.kind === 'name' && lastNo && mk.value) {
      const key = `${lastNo}|${mk.value}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ number: lastNo, name: mk.value, detailUrl: lastLink })
      }
    }
  }
  return out
}

/**
 * 引けなかったときは 'none'（免許なし）ではなく 'notfound'（照合できず）を返す。
 *
 * 検索が0件なのは「免許が無い」ではなく「この社名では引けなかった」であって、
 * 両者は別の事実。2026-06-06〜07-07 は検索が一度も成立しておらず、66社が
 * 一律 'none' で固定され、うち Kaizen Tech Agent（派13-318064）など実在の
 * 派遣元が「免許なし」と赤字表示されていた。p_require_haken の絞り込みにも
 * 効くので、この取り違えは人材をマッチングから丸ごと落とす。
 * 断定は人（verified_by が cron 以外）だけができる。
 */
export function determineLicenseStatus(haken: string[], shokai: string[]): string {
  if (haken.length > 0 && shokai.length > 0) return 'both'
  if (haken.length > 0) return 'haken'
  if (shokai.length > 0) return 'shokai'
  return 'notfound'
}

/**
 * 半角英数字・空白を全角に寄せる。
 *
 * 厚労省サイトは事業主名を全角で持っており（「株式会社ＧＦＤ」）、部分一致検索は
 * 文字種を吸収しない。"GFD" では0件、"ＧＦＤ" で 派14-301189 が返る。
 * 英字を含む社名が軒並み引けていなかった原因がこれ（2026-09-12 実測）。
 */
export function toFullWidth(s: string): string {
  return s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, '　')
}

/** 検索前の掃除。機種依存の㈱・行頭の装飾記号は検索を素通りで0件にする */
export function normalizeForSearch(name: string): string {
  return (name ?? '')
    .replace(/㈱/g, '株式会社')
    .replace(/㈲/g, '有限会社')
    .replace(/^[\s　]*[━─―ー−\-=＝*＊#＃■□●○◆◇▼▲・>＞|｜]+[\s　]*/, '')
    // 末尾の罫線。長音「ー」は社名の一部になりうるので外さない
    .replace(/[━─―＝=＊#＃■□●○◆◇▼▲★☆┓┏┛┗│┃｜|\s　]+$/, '')
    .trim()
}

/** 法人格を外した識別名。外せなければ null */
export function stripCorp(name: string): string | null {
  const s = name
    .replace(/^(?:株式会社|合同会社|有限会社|合資会社|一般社団法人|一般財団法人|医療法人)[\s　]*/, '')
    .replace(/[\s　]*(?:株式会社|合同会社|有限会社|合資会社)$/, '')
    .trim()
  return s && s !== name ? s : null
}

/**
 * 社名の突合キー。全角/半角・記号・空白・法人格の違いを落として比べる。
 * 表示用の正規化ではないので、ここで作った文字列を画面に出さないこと。
 */
export function companyKey(name: string): string {
  return normalizeForSearch(name)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　・･,，.．'’"”\-‐－–—_＿&＆]/g, '')
    .replace(/^(?:株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|医療法人|協同組合)/, '')
    .replace(/(?:株式会社|有限会社|合同会社|合資会社)$/, '')
    .toUpperCase()
}

/**
 * 検索結果の事業主名が、こちらの持っている社名と同じ会社を指しているか。
 *
 * 部分一致検索なので、法人格を外したキーは平気で別会社を連れてくる。実測（2026-09-12）:
 *   「株式会社ストリーク」→「エクストリーク株式会社」（派13-040467）
 *   「NHK」            →「株式会社ＮＨＫビジネスクリエイト」（派13-304310）
 *   「株式会社中小企業」  →「協同組合中小企業経営技術研究会」（派25-300406）
 * 他社の許可番号を貼るのは「免許なし」より悪い。完全一致したときだけ採用する。
 */
export function isSameCompany(officialName: string, ourName: string): boolean {
  const a = companyKey(officialName)
  return a.length >= 2 && a === companyKey(ourName)
}

/**
 * 試す検索キーを重複なく順に返す。
 * 素の社名 → 全角版 → 法人格なし → 法人格なし全角版。
 * 法人格を外したキーは同名の別会社を拾いやすいので必ず後ろに置く
 * （採否は isSameCompany が決めるので、順番は「先に正確なキーを試す」ためのもの）。
 */
export function searchVariants(rawName: string): string[] {
  const base = normalizeForSearch(rawName)
  if (!base) return []
  const short = stripCorp(base)
  const keys = [base, toFullWidth(base)]
  if (short && short.length >= 2) keys.push(short, toFullWidth(short))
  return [...new Set(keys.filter((k) => k.length > 0))]
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
    // 未確認（verified_at が NULL）を先に。加えて「照合できず」で終わった会社は
    // RETRY_AFTER_DAYS 後にもう一度引き直す。
    // 一度 verified_at が付くと二度と見に行かない作りだったため、検索が壊れていた
    // 2026-06〜07 の判定が3か月固定されたままだった。取れなかった側は必ず腐る。
    const retryBefore = new Date(Date.now() - RETRY_AFTER_DAYS * 86400_000).toISOString()
    query = supabase
      .from('agent_companies')
      .select('domain, company_name, haken_number, license_status, verified_at')
      .not('company_name', 'is', null)
      .or(`verified_at.is.null,and(license_status.eq.notfound,verified_at.lt.${retryBefore})`)
      .order('verified_at', { ascending: true, nullsFirst: true })
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

  const results: { domain: string; status: string; haken: string[]; shokai: string[]; matchedKey?: string | null; error?: string }[] = []

  for (const company of companies as AgentCompany[]) {
    if (!company.company_name) continue

    // 社名の表記ゆれ（半角英字・㈱・行頭の装飾記号・法人格の有無）を吸収した検索キー列
    const variants = searchVariants(company.company_name)

    let haken: string[] = company.haken_number ? [company.haken_number] : []
    let shokai: string[] = []
    let hakenDetailUrl: string | null = null
    let correctedCompanyName: string | null = null
    let matchedKey: string | null = null
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
        // 表記ゆれを吸収した順（素 → 全角 → 法人格なし → 法人格なし全角）で、
        // 当たるまで試す。0件を「免許なし」と決めてよいのは全部外したときだけ。
        for (const [vi, key] of variants.entries()) {
          if (vi > 0) await new Promise((r) => setTimeout(r, 500)) // レートリミット対策
          const entries = await searchMHLW(key)
          // 部分一致検索なので、名前が一致した行だけを自社のものとして採る。
          // ここを緩めると他社の許可番号を貼ることになる（「免許なし」より悪い）
          const mine = entries.filter((e) => isSameCompany(e.name, company.company_name!))
          if (mine.length > 0) {
            const h = [...new Set(mine.map((e) => e.number).filter((n) => n.startsWith('派')))]
            const s = [...new Set(mine.map((e) => e.number).filter((n) => !n.startsWith('派')))]
            // 同じ社名の事業主が複数ある（「株式会社フォワード」は東京と愛媛に別々に実在）。
            // どれがこのドメインの会社かは名前からは決められないので、当てずっぽうで
            // 番号を貼らず「照合できず」のまま人に回す。
            if (h.length > 1) {
              console.log(`[verify-agent-license] ${company.domain}: 同名が複数 ${h.join(',')} → 特定できず`)
              break
            }
            haken = h
            shokai = s
            hakenDetailUrl = mine.find((e) => e.number.startsWith('派'))?.detailUrl ?? null
            matchedKey = key
            break
          }
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

    // どの表記で引けたかを残す（引けなかった社を後から詰めるのに要る）
    results.push({ domain: company.domain, status, haken, shokai, matchedKey, error: errMsg })

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
