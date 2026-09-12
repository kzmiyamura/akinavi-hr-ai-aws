/**
 * 厚労省「人材サービス総合サイト」事業主名検索の共通処理。
 *
 * 2026-09-12 に判明した重要な性質:
 *   このサイトは事業主名を **全角英数字** で保持している（「株式会社ＧＦＤ」）。
 *   部分一致検索は文字種を吸収しないため、半角のまま引くと 0 件になる。
 *     "GFD"  → 0件      "ＧＦＤ" → 派14-301189
 *   社名に英字を含む会社が軒並み「免許なし」と記録されていた原因がこれ。
 *
 * したがって検索キーは1つではなく、素の社名・法人格なし・全角版の順に試す。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SEARCH_URL = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
/** フォームの例示値・検索ノイズとして HTML に常駐する番号 */
const HAKEN_FAKE = new Set(['派01-000001', '派13-307608'])

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 検索キーの作り方と判定は **本番に出す Edge Function から切り出して** 使う。
 * ここに写しを置くと、本番と手元で違う社名を引いて「直したつもり」になる。
 */
const EDGE_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../supabase/functions/verify-agent-license/index.ts',
)

function loadFromEdgeFunction() {
  const src = readFileSync(EDGE_SRC, 'utf8')
  const pick = (name) => {
    const m = src.match(new RegExp(`export function ${name}\\(([\\s\\S]*?)\\n\\}`))
    if (!m) throw new Error(`${name} を verify-agent-license/index.ts から取り出せませんでした`)
    return `function ${name}(${m[1]}\n}`
      .replace(/: \{ number: string; name: string; detailUrl: string \| null \}\[\]/g, '')
      .replace(/: \{ at: number; kind: string; value: string \}\[\]/g, '')
      .replace(/: string\[\]/g, '')
      .replace(/: string \| null/g, '')
      .replace(/: string/g, '')
      .replace(/: boolean/g, '')
      .replace(/new Set<string>\(\)/g, 'new Set()')
  }
  const code = `
    ${pick('toFullWidth')}
    ${pick('normalizeForSearch')}
    ${pick('stripCorp')}
    ${pick('companyKey')}
    ${pick('isSameCompany')}
    ${pick('searchVariants')}
    ${pick('parseSearchResults')}
    ${pick('determineLicenseStatus')}
    return { toFullWidth, normalizeForSearch, stripCorp, companyKey, isSameCompany,
             searchVariants, parseSearchResults, determineLicenseStatus }
  `
  return new Function(code)()
}

export const {
  toFullWidth,
  normalizeForSearch,
  stripCorp,
  companyKey,
  isSameCompany,
  searchVariants,
  parseSearchResults,
  determineLicenseStatus,
} = loadFromEdgeFunction()

async function establishSession() {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'screenId=GICB102010&action=initDisp',
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`init HTTP ${res.status}`)
  return (res.headers.get('set-cookie') ?? '').match(/JSESSIONID=([^;]+)/)?.[1] ?? ''
}

/** 会社名1つで検索し、許可番号・事業主名・詳細ページURLを返す */
export async function searchByName(name) {
  const jsid = await establishSession()
  const params = new URLSearchParams({
    screenId: 'GICB102010',
    action: 'search',
    cbZenkoku: '1',
    txtJigyonushiName: name,
    cbJigyonushiName: '1',
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
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: SEARCH_URL,
      ...(jsid ? { Cookie: `JSESSIONID=${jsid}` } : {}),
    },
    body: params.toString(),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`search HTTP ${res.status}`)
  const html = await res.text()

  return parseSearchResults(html).map((e) => ({
    ...e,
    detailUrl: e.detailUrl ? new URL(e.detailUrl, SEARCH_URL).toString() : null,
  }))
}

/**
 * 許可番号で引いて、正式な事業主名を取る。
 * 社名が取れていない・壊れている会社でも、番号さえ合っていれば名前を復元できる。
 */
export async function searchByNumber(hakenNumber) {
  const m = String(hakenNumber).match(/^派(\d{2})-(\d{6})$/)
  if (!m) throw new Error(`派遣許可番号の形式ではない: ${hakenNumber}`)
  const jsid = await establishSession()
  const params = new URLSearchParams({
    screenId: 'GICB102010',
    action: 'search',
    cbZenkoku: '1',
    ucKyokatodokedeNo1: '1', // 「派」区分
    txtKyokatodokedeNo2: m[1],
    txtKyokatodokedeNo3: m[2],
    'nm_btnSearch.x': '1',
    'nm_btnSearch.y': '1',
  })
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: SEARCH_URL,
      ...(jsid ? { Cookie: `JSESSIONID=${jsid}` } : {}),
    },
    body: params.toString(),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`number search HTTP ${res.status}`)
  return parseSearchResults(await res.text()).map((e) => ({
    ...e,
    detailUrl: e.detailUrl ? new URL(e.detailUrl, SEARCH_URL).toString() : null,
  }))
}

/**
 * 社名の表記ゆれを吸収しながら検索する。ヒットしたキーも返すので、
 * 「どの書き方なら引けたか」を後から確認できる。
 * リクエスト間隔は呼び出し側の responsibility ではなくここで守る（厚労省サイト保護）。
 *
 * 部分一致検索なので、**事業主名が一致した行だけ**を自社のものとして採る。
 * 緩めると「株式会社ストリーク」に「エクストリーク株式会社」の番号が付く。
 * `nearMiss` には、番号は取れたが名前が一致しなかった行を入れて、
 * 「社名が壊れているのか、本当に登録が無いのか」を後から切り分けられるようにする。
 */
export async function lookupCompany(rawName, { gapMs = 1500 } = {}) {
  const keys = searchVariants(rawName)
  const tried = []
  const nearMiss = []
  for (const key of keys) {
    if (tried.length > 0) await sleep(gapMs)
    tried.push(key)
    const entries = await searchByName(key)
    const mine = entries.filter((e) => isSameCompany(e.name, rawName))
    if (mine.length > 0) {
      const haken = [...new Set(mine.map((e) => e.number).filter((n) => n.startsWith('派')))]
      const shokai = [...new Set(mine.map((e) => e.number).filter((n) => !n.startsWith('派')))]
      // 同じ社名の事業主が複数（「株式会社フォワード」は東京と愛媛に別々に実在）。
      // どれがこのドメインの会社かは名前からは決まらないので、当てずっぽうで貼らない
      if (haken.length > 1) {
        return {
          haken: [], shokai: [], names: [...new Set(mine.map((e) => e.name))],
          detailUrl: null, hit: false, status: 'notfound', matchedKey: null,
          tried, nearMiss, ambiguous: haken,
        }
      }
      return {
        haken,
        shokai,
        names: [...new Set(mine.map((e) => e.name))],
        detailUrl: mine.find((e) => e.number.startsWith('派'))?.detailUrl ?? null,
        hit: true,
        status: determineLicenseStatus(haken, shokai),
        matchedKey: key,
        tried,
        nearMiss,
      }
    }
    for (const e of entries) {
      if (!nearMiss.some((n) => n.number === e.number && n.name === e.name)) nearMiss.push(e)
    }
  }
  return {
    haken: [], shokai: [], names: [], detailUrl: null, hit: false,
    status: 'notfound', matchedKey: null, tried, nearMiss,
  }
}
