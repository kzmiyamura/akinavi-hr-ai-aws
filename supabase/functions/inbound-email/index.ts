// Supabase Edge Function: Make.com (Outlook) → AI解析 → DB保存
// Runtime: Deno / タイムアウト: 最大150秒（Vercel Hobbyの10秒制限を回避）
// POST body (form-urlencoded or JSON):
//   type, from, subject, body
//   mode または data_env: prod | demo | dev（dev は demo と同じ。省略時は prod）
//   ?mode=demo や ?data_env=demo（Webhook URL のクエリ）も可（ボディが空のとき補完）
//   ヘッダ X-Data-Env / X-Mode も補完として利用可
//   attachment[data], attachment[mimeType], attachment[name]
//   attachmentsJson: JSON 配列文字列 [{data,mimeType,name?} | Pipedream: content_base64,content_type,name]
//   attachments: 上記と同じ配列を JSON.stringify したトップレベルキー（application/json ボディ時）
//   本文・添付とも空: HTTP 200 + skipped（Make 継続）。DB は書かない。
//   INBOUND_RELEVANCE_CHECK: false で事前の無関係メール判定を無効化（既定は true）
//   ※ 全体の壁時計は Edge の上限もあり（関連度・Drive取得・Gemini の合計。プランにより概ね150〜400秒程度）
//   INBOUND_MAKE_SOFT_FAIL=true: 例外時も HTTP 200 + ok:false（Make がエラーでシナリオ停止しにくくする）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// Word/Excel: esm.sh の動的 import は Edge 上で ERR_MODULE_NOT_FOUND になることがあるため npm: を使用

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Attachment {
  data: string
  mimeType: string
  name?: string
}

/**
 * 添付オブジェクトの配列を正規化（Pipedream 等: `content_base64` / `content_type` / `name`。
 * Make 互換: `data` / `mimeType` / `name`）
 */
function attachmentsFromParsedArray(parsed: unknown[]): Attachment[] {
  const out: Attachment[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const dataRaw = o.data ?? o.content_base64 ?? o.contentBytes
    if (typeof dataRaw !== 'string' || !dataRaw.trim()) {
      console.warn('[attach] data空のためスキップ:', { name: o.name, mimeType: o.mimeType, dataType: typeof dataRaw, dataLen: typeof dataRaw === 'string' ? dataRaw.length : 0 })
      continue
    }
    const mimeRaw = o.mimeType ?? o.content_type ?? o.contentType ?? ''
    const nameRaw = o.name
    out.push({
      data: dataRaw.trim(),
      mimeType: typeof mimeRaw === 'string' ? mimeRaw : String(mimeRaw ?? ''),
      name: nameRaw != null && String(nameRaw).trim() ? String(nameRaw) : undefined,
    })
  }
  return out
}

/** JSON 配列文字列（トップレベルが `attachments` として stringify されたもの） */
function attachmentsFromJsonArrayString(jsonStr: string): Attachment[] {
  const s = jsonStr.trim()
  if (!s.startsWith('[')) return []
  try {
    const parsed = JSON.parse(s) as unknown
    if (!Array.isArray(parsed)) return []
    return attachmentsFromParsedArray(parsed)
  } catch {
    return []
  }
}

const SUPPORTED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']

const WORD_MIME = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.ms-word.document.macroEnabled.12',                      // .docm
]
const EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',                        // .xlsm（マクロ有効）
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12',                 // .xlsb（バイナリ）
]

function getEnv(key: string): string {
  const val = Deno.env.get(key)
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`)
  return val
}

/** Microsoft Graph API の from フィールド（JSON文字列の場合も）からメールアドレスを取り出す */
function parseFrom(from: string): string {
  try {
    const obj = JSON.parse(from)
    return obj?.emailAddress?.address ?? from
  } catch {
    return from
  }
}

/** メール本文中の HTML エンティティをデコードする（例: &#31292; → 稼） */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** AI が返した日付を projects.start_date / end_date に渡せる YYYY-MM-DD のみ採用 */
function parseIsoDateOnly(value: unknown): string | null {
  if (value == null || typeof value !== 'string') return null
  const s = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = Date.parse(`${s}T12:00:00`)
  if (Number.isNaN(t)) return null
  return s
}

function parseOptionalInt(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10)
  if (!Number.isFinite(n)) return null
  const x = Math.trunc(n)
  if (x < min || x > max) return null
  return x
}

/** 月額万円など、AIが number / 数値文字列で返すフィールド向け */
function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = parseFloat(String(value).replace(/[,，]/g, '').trim())
  if (!Number.isFinite(n)) return null
  return n
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  return s.length > 0 ? s : null
}

/** Make 等からの mode（prod | demo | dev）。dev は demo の別名。不正・省略は prod */
function resolveInboundDataEnv(modeRaw: unknown): 'prod' | 'demo' {
  const s = String(modeRaw ?? '').trim().toLowerCase()
  if (s === 'demo' || s === 'dev') return 'demo'
  return 'prod'
}

/** ボディに無いキーだけ URL クエリで埋める（Make が ?mode=demo を URL に付ける運用向け） */
function mergeUrlSearchParamsIntoRaw(req: Request, raw: Record<string, string>): void {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  for (const [k, v] of url.searchParams.entries()) {
    const t = String(v ?? '').trim()
    if (!t) continue
    const cur = raw[k]
    if (cur == null || String(cur).trim() === '') {
      raw[k] = v
    }
  }
}

/**
 * Make が mode / data_env / 大小文字違い / URL・ヘッダで渡すケースをまとめて解決する。
 */
function pickInboundMode(raw: Record<string, string>, req: Request): unknown {
  const explicitKeys = ['mode', 'data_env', 'dataEnv']
  for (const k of explicitKeys) {
    const v = raw[k]
    if (v != null && String(v).trim() !== '') return v
  }
  for (const key of Object.keys(raw)) {
    const lower = key.toLowerCase()
    if (lower === 'mode' || lower === 'data_env') {
      const v = raw[key]
      if (v != null && String(v).trim() !== '') return v
    }
  }
  const h = req.headers.get('x-data-env') ?? req.headers.get('x-mode')
  if (h != null && String(h).trim() !== '') return h.trim()
  return undefined
}

/**
 * Make が type に空文字や未設定を渡すと raw.type ?? 'candidate' が効かず 400（不明な type）になるため正規化する。
 */
function normalizeInboundType(rawType: string | undefined): string {
  const t = String(rawType ?? '').trim().toLowerCase()
  if (t === '' || t === 'candidate' || t === 'human') return t === 'human' ? 'human' : 'candidate'
  if (t === 'project') return 'project'
  return 'candidate'
}

/** Make / Outlook 連携で本文フィールド名が揃わない場合のよくある別名 */
function pickEmailPlainBody(raw: Record<string, string>): string {
  const keys = [
    'body',
    'text',
    'plainText',
    'bodyText',
    'bodyPreview',
    'body_preview',
    'uniqueBody',
    'emailBody',
    'message',
    'content',
    'snippet',
  ]
  for (const k of keys) {
    const v = raw[k]
    if (v != null && String(v).trim().length > 0) return String(v)
  }
  return ''
}

/** Microsoft Graph のメール本文が JSON（contentType + content）で届く場合に本文だけ取り出す */
function unwrapMicrosoftGraphBody(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{')) return text
  try {
    const o = JSON.parse(t) as Record<string, unknown>
    if (typeof o.content === 'string' && o.content.trim()) return o.content
    const b = o.body
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      const inner = b as Record<string, unknown>
      if (typeof inner.content === 'string' && inner.content.trim()) return inner.content
    }
  } catch {
    return text
  }
  return text
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(bin)
}

/** AI の skills 配列を trim・重複除去（大文字小文字無視） */
/** "27年9ヶ月" や "5" など様々な形式の経験年数を整数に変換する */
function toExperienceYears(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  const s = String(value)
  // 先頭の数字部分を取り出す（"27年9ヶ月" → 27、"5.5" → 5）
  const m = s.match(/^(\d+)/)
  if (!m) return null
  const years = parseInt(m[1], 10)
  // 0〜50年の範囲外は異常値（年号4桁誤マッチ・ハルシネーション等）として null に落とす
  if (years < 0 || years > 50) return null
  return years
}

/**
 * セクション見出しリストからテキストを抽出するユーティリティ。
 * 最大500文字・複数セクション発見時は \n\n で結合。見つからない場合は null。
 */
// 送信者署名の開始を示す行パターン（自己PR等の抽出をここで打ち切る）
const SIGNATURE_START_RE = /(?:^|\n)[ 　]*(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|[\S]{2,15}株式会社)|(?:^|\n)[ 　]*(?:TEL|FAX|Tel|Fax|電話|℡)[ 　]*[：:（(]?\s*[\d(（0]|(?:^|\n)[ 　]*〒\d{3}[-ー]\d{4}|(?:^|\n)[ 　]*E[-－]?[Mm]ail\s*[：:]/m

function extractSectionsByLabels(text: string, labels: string[]): string | null {
  if (!text.trim()) return null
  const prefix = '[【◆■●▼★◎※◇☆]?'
  const suffix = '[】：: 　\n]+'
  const labelPattern = labels.map(l => `(?:${prefix}${l}${suffix})`).join('|')
  const sectionRe = new RegExp(`(?:${labelPattern})([\\s\\S]{1,600})`, 'gi')
  const found: string[] = []
  let match: RegExpExecArray | null
  while ((match = sectionRe.exec(text)) !== null) {
    let content = match[1]
    const nextLabel = new RegExp(`(?:${labelPattern})`, 'i')
    const cutIdx = content.search(nextLabel)
    if (cutIdx > 0) content = content.slice(0, cutIdx)
    const blankIdx = content.search(/\n\s*\n/)
    if (blankIdx > 0 && blankIdx < 300) content = content.slice(0, blankIdx)
    // 送信者署名の開始行で打ち切り（株式会社 / TEL / 〒 / Email 等）
    const sigIdx = content.search(SIGNATURE_START_RE)
    if (sigIdx > 0) content = content.slice(0, sigIdx)
    content = content.trim().slice(0, 500)
    if (content.length >= 5) found.push(content)
  }
  if (found.length === 0) return null
  return found.join('\n\n').slice(0, 500)
}

/** 候補者本人の自己PR（自己PR / PR / アピールポイント / 強み 等）を抽出する。
 * スプレッドシート等の添付データは対象外（誤マッチ防止）。 */
function extractSelfPR(body: string, _attachText: string): string | null {
  // 'PR' 単体は短すぎてURL中・一般テキスト（PR会社等）に誤マッチするため除外
  return extractSectionsByLabels(body, [
    '自己PR', 'アピールポイント', '特徴・強み', '強み', '紹介文', '本人PR',
  ])
}

/** エージェントコメント（担当者所感・推薦コメント・人物評等）を抽出する。
 * スプレッドシート等の添付データは対象外（誤マッチ防止）。
 * 「備考」はメール内での用途が曖昧（候補者自身のメモにも使われる）ため除外。 */
function extractAgentComment(body: string, _attachText: string): string | null {
  return extractSectionsByLabels(body, [
    '弊社コメント', 'エージェントコメント', '担当者コメント', 'コーディネーターコメント',
    '営業コメント', '推薦コメント', '所感', '推薦理由', '特記事項',
    '人物像', '人物', '所見', '印象', '弊社担当者から一言',
    // 【紹　介】形式（全角スペース区切り、ドリームビジョン等）
    '紹　介', '紹介',
  ])
}

/** 自社名（受信側）として登録されてしまうことを防ぐ会社名リスト */
const OWN_COMPANY_NAMES = ['株式会社ボイス', 'i-voice', 'アキナビ', 'akinavi', '株式会社アキナビ']

function sanitizeFromCompany(value: string | null | undefined): string | null {
  if (!value) return null
  let trimmed = value.trim()
  // 自社名・空文字は null に落とす
  if (!trimmed) return null
  for (const own of OWN_COMPANY_NAMES) {
    if (trimmed.toLowerCase().includes(own.toLowerCase())) return null
  }
  // 法人格の後ろに続く部署名・担当者名を除去
  // 例: 「株式会社GFDの本田でございます。」→「株式会社GFD」
  //     「株式会社GFDビジネス推進本部の佐藤です。」→「株式会社GFDビジネス推進本部」
  // 「の」なし・漢字姓+丁寧表現: 「株式会社イチアール小島でございます」→「株式会社イチアール」
  // ※ 法人格+会社名(2文字以上)の後に1〜4文字の漢字姓+丁寧表現が続くパターン
  {
    const politePersonM = trimmed.match(/^((?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人).{2,}?)[一-龯々]{1,4}(?:でございます|です|と申します|でした)/)
    if (politePersonM) trimmed = politePersonM[1]
  }
  // 「の〇〇でございます」「の〇〇です」等が残っていれば除去（の付きのフォールバック）
  trimmed = trimmed.replace(/の[^\s　]{1,15}(?:でございます|です|と申します|でした).*$/, '')
  // 前株パターン: 法人格 + 会社名（英語2単語名「Knowledge Technologies」にも対応）
  // ただし「株式会社ヘルスベイシス https://...」のように直後にURLが続く場合、
  // urlの先頭語（https等）を会社名の一部として誤って取り込まないよう除外する
  const preM = trimmed.match(/^((?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[^\sの　\n、。！（）【】「」]{2,30}(?:[ \t]+(?!https?:)[A-Za-z][A-Za-z \t&.]{0,20})?)/)
  if (preM) { trimmed = preM[1].trim(); }
  // 後株パターン: 会社名 + 法人格 (以降を除去)
  const postM = trimmed.match(/^([^\sの　\n、。！（）【】「」]{2,20}(?:株式会社|有限会社|合同会社))/)
  if (postM) { trimmed = postM[1]; }
  // 法人格のみ（識別名なし）は無効 — 例: 「株式会社の小川です」→「株式会社」→ null
  if (/^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)$/.test(trimmed)) return null
  // 役職・肩書き略称がそのまま会社名になっているケースは無効
  // 例: 「株式会社CTO」「株式会社CEO」— スキルシートの役職行が誤マッチした場合
  if (/^(?:株式会社|有限会社|合同会社)(?:CTO|CEO|COO|CFO|CMO|CXO|VP|SVP|EVP|PO|PM|PL|SE|SRE|TL)$/.test(trimmed)) return null
  return trimmed || null
}

/**
 * 雇用形態・所属を「商流位置」と「雇用形態」の2次元に分離して抽出する。
 * 単一候補パス・マルチ候補パス共通で使用。
 * 対応ラベル: 雇用形態 / 就業形態 / 立場 / 所属 / 属性 / 契約形態 / 【 所 属 】等
 *
 * 返り値:
 *   commercialFlow: 商流位置。'自社' | '1社先' | '2社先' | ... | null(不明)
 *     → 「うちの会社からの紹介で客先常駐できるか」の判断用（自社=直接可・N社先=N社挟む）
 *   employmentType: 雇用形態。'正社員' | 'フリーランス' | '契約社員' | '派遣社員' | '業務委託' | null
 *     → SESは「どこかの正社員が客先常駐する働き方」なので該当商流の正社員に開く（案B）
 *
 * 「1社先正社員」のように商流と形態が複合した表記も、両方を保持できる。
 */
const KANJI_TO_NUM: Record<string, string> = {
  '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
  '六': '6', '七': '7', '八': '8', '九': '9', '十': '10',
}
function normalizeShaNum(raw: string): string {
  // 全角数字→半角、漢数字→アラビア数字
  const zen = raw.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))
  return KANJI_TO_NUM[zen] ?? zen
}
/** 値文字列から {商流位置, 雇用形態} を判定する（内部ヘルパー） */
function parseEmploymentValue(val: string): { commercialFlow: string | null; employmentType: string | null } {
  let commercialFlow: string | null = null
  let employmentType: string | null = null
  // 商流: N社先（漢数字/全角対応）
  const nShaM = val.match(/([0-9０-９一二三四五六七八九十]+)[　 ]*社先/)
  if (nShaM) commercialFlow = `${normalizeShaNum(nShaM[1])}社先`
  // 雇用形態（SES→正社員に開く。N社先社員/正社員→正社員）
  if (/フリー(?:ランス)?|個人事業/.test(val)) employmentType = 'フリーランス'
  else if (/契約社員/.test(val)) employmentType = '契約社員'
  else if (/派遣社員|派遣/.test(val)) employmentType = '派遣社員'
  else if (/業務委託/.test(val)) employmentType = '業務委託'
  else if (/SES/.test(val)) employmentType = '正社員'
  else if (/正社員|社先[　 ]*社員/.test(val)) employmentType = '正社員'
  // 商流の記載がなく雇用形態が取れた場合は「自社」とみなす
  if (!commercialFlow && employmentType) commercialFlow = '自社'
  return { commercialFlow, employmentType }
}
function extractEmploymentType(bodyText: string, attachText: string): { commercialFlow: string | null; employmentType: string | null } {
  const t = bodyText + ' ' + attachText
  // 【 所 属 】形式（スペース区切り全角ラベル）: SES業界の複数人材メールに多い
  const bracketM = t.match(/【[　 ]*所[　 ]*属[　 ]*】[　 ]*([^\n【】]{1,30})/)
  if (bracketM) {
    const r = parseEmploymentValue(bracketM[1].trim())
    if (r.commercialFlow || r.employmentType) return r
  }
  // ラベルあり（コロン区切り）: 雇用形態・就業形態・立場・所属・属性等
  const labelM = t.match(/(?:雇用形態|就業形態|立場|エンジニアの立場|現在の立場|契約形態|ご状況|属性|所属)[　 ]*[：:][　 ]*([^\n]{1,30})/)
  if (labelM) {
    const r = parseEmploymentValue(labelM[1].trim())
    if (r.commercialFlow || r.employmentType) return r
  }
  // ラベルなし（文脈パターン）
  // 商流表現（弊社=自社／N社先）は文脈からも拾う
  const ctxNSha = t.match(/([0-9０-９一二三四五六七八九十]+)[　 ]*社先[　 ]*(正社員|社員|フリー(?:ランス)?)?/)
  if (ctxNSha) {
    const flow = `${normalizeShaNum(ctxNSha[1])}社先`
    const form = ctxNSha[2] ? (/フリー/.test(ctxNSha[2]) ? 'フリーランス' : '正社員') : null
    return { commercialFlow: flow, employmentType: form }
  }
  if (/弊社[　 ]*(正社員|社員)/.test(t)) return { commercialFlow: '自社', employmentType: '正社員' }
  if (/[（(]正社員[）)]|正社員として登録|正社員エンジニア/.test(t)) return { commercialFlow: '自社', employmentType: '正社員' }
  if (/フリーランス(エンジニア|技術者|の方|候補|案件)?|個人事業主/.test(t)) return { commercialFlow: '自社', employmentType: 'フリーランス' }
  if (/業務委託(契約|のみ|希望|での)?/.test(t)) return { commercialFlow: '自社', employmentType: '業務委託' }
  if (/弊社SES|SES(?:エンジニア|技術者|正社員|社員)/.test(t)) return { commercialFlow: '自社', employmentType: '正社員' }
  if (/契約社員/.test(t)) return { commercialFlow: '自社', employmentType: '契約社員' }
  if (/派遣社員/.test(t)) return { commercialFlow: '自社', employmentType: '派遣社員' }
  return { commercialFlow: null, employmentType: null }
}

/**
 * メール本文から労働者派遣事業・職業紹介事業の許可番号を抽出する。
 * 署名欄の「派 13-317179」「13-ユ-123456」等に対応。
 */
function extractLicenseNumbers(text: string): { haken: string | null; shokai: string | null } {
  // 派遣許可番号: 「派 13-317179」「派13-317179」→「派13-317179」
  const hakenM = text.match(/派\s*(\d{2}-\d{6})/)
  const haken = hakenM ? `派${hakenM[1]}` : null
  // 職業紹介許可番号: 「13-ユ-123456」「13-ユ123456」
  const shokaiM = text.match(/(\d{2}-ユ[-ー]?\d{6})/)
  const shokai = shokaiM ? shokaiM[1] : null
  return { haken, shokai }
}

/**
 * メール本文の文章からスキル別経験年数を抽出する（Excel/Word添付がない場合のフォールバック）。
 * 対応パターン:
 *   1. 「PHP(Laravel)、JavaScript(Vue)の経験がそれぞれ3年以上あります」→ PHP:36, JavaScript:36
 *   2. 「Javaの経験が5年以上」→ Java:60
 *   3. 「Python 3年」「AWS（2年）」→ Python:36, AWS:24（箇条書き風）
 */
function extractSkillYearsFromBodyText(text: string): Record<string, number> {
  const result: Record<string, number> = {}

  // 全角数字を半角に変換して年数を月数へ
  const parseYearsToMonths = (s: string): number | null => {
    const m = s.match(/([0-9０-９]+)年/)
    if (!m) return null
    const n = parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    return isNaN(n) || n < 1 || n > 40 ? null : n * 12
  }

  // 括弧内の補足・ラベルプレフィックスを除去してスキル名だけ返す
  // 「PHP(Laravel)」→「PHP」 / 「アピールポイント: PHP」→「PHP」
  const cleanSkillName = (s: string): string => {
    let r = s.replace(/\s*[（(][^）)]*[）)]/g, '').replace(/[・、,，\s　]+$/, '').trim()
    // コロン・全角コロンがある場合は最後のコロン以降を取る
    const colonIdx = Math.max(r.lastIndexOf('：'), r.lastIndexOf(':'))
    if (colonIdx >= 0) r = r.slice(colonIdx + 1).trim()
    return r
  }

  // スキル名として不適切な語句（除外リスト）
  const isNonSkill = (name: string): boolean => {
    if (name.length < 2 || name.length > 30) return true
    return /経験|以上|程度|開発|業務|システム|設計|構築|基盤|インフラ|サービス|アプリ|エンジニア|実務|案件|プロジェクト|当社|弊社|担当|スキル/.test(name)
  }

  // パターン1: 「スキル1、スキル2の経験がそれぞれN年以上」（複数スキル・同一年数）
  const patternEach = /([^\n。]{2,80})の経験がそれぞれ([0-9０-９]+年)/g
  let m: RegExpExecArray | null
  while ((m = patternEach.exec(text)) !== null) {
    const months = parseYearsToMonths(m[2])
    if (!months) continue
    const skills = m[1].split(/[、,，・とやおよび及び]/)
    for (const raw of skills) {
      const name = cleanSkillName(raw)
      if (!isNonSkill(name)) {
        result[name] = Math.max(result[name] ?? 0, months)
      }
    }
  }

  // パターン2: 「スキルの経験がN年以上」（単一スキル。それぞれ除外）
  const patternSingle = /([^\s　、,，・（(）)\n]{2,20})の経験が(?!それぞれ)([0-9０-９]+年)/g
  while ((m = patternSingle.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name)) {
      result[name] = Math.max(result[name] ?? 0, months)
    }
  }

  // パターン3: 「スキル：N年」「スキル（N年）」「スキル（約N年）」（明示的なコロン・括弧区切り必須）
  // 「スキル 年」のようなスペース区切りは日付と誤爆しやすいため除外
  // 約・おおよそ等のプレフィックスも対応
  const patternLabel = /([A-Za-z][A-Za-z0-9+#. _/-]{0,19}|[ァ-ヶー]{2,15}|[一-龯々]{2,10})\s*[：:（(]\s*約?\s*([0-9０-９]+年[0-9０-９]*[ヶかカ]?月?)/g
  while ((m = patternLabel.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name) && !(name in result)) {
      // パターン3は1,2で取得済みのキーには上書きしない
      result[name] = months
    }
  }

  // パターン3b: 「スキル（Nヶ月）」（月数のみ・年なし）
  // 例: Java(2年2ヶ月) は pattern3 で捕捉済み、Springboot(6ヶ月) はこちら
  const patternMonthsOnly = /([A-Za-z][A-Za-z0-9+#. _/-]{0,19}|[ァ-ヶー]{2,15})\s*[（(]\s*([0-9０-９]+)[ヶかカヵｶ]月\s*[）)]/g
  while ((m = patternMonthsOnly.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const mo = parseInt(m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    if (!isNaN(mo) && mo >= 1 && mo <= 360 && !isNonSkill(name) && !(name in result)) {
      result[name] = mo
    }
  }

  // パターン3c: 「スキル歴N年」「スキル歴N年以上」
  // 例: Laravel歴7年以上、Java歴10年
  const patternRekiYear = /([A-Za-z][A-Za-z0-9+#. _/-]{1,19}|[ァ-ヶー]{2,15}|[一-龯々]{2,10})歴\s*([0-9０-９]+)\s*年/g
  while ((m = patternRekiYear.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const yrs = parseInt(m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    if (!isNaN(yrs) && yrs >= 1 && yrs <= 40 && !isNonSkill(name) && !(name in result)) {
      result[name] = yrs * 12
    }
  }

  // パターン3d: 【スキル】セクション後のスラッシュ区切り「Java(約15年以上) / Kotlin(約8年)」
  // 行内のスラッシュで区切られた「スキル名(約?N年)」形式を一括抽出
  const slashSkillSection = text.match(/(?:【スキル】|スキル[：:]\n?)([^\n]{10,300})/)
  if (slashSkillSection) {
    const sectionLine = slashSkillSection[1]
    const slashParts = sectionLine.split(/\s*[/／]\s*/)
    for (const part of slashParts) {
      const pm = part.trim().match(/^([A-Za-z][A-Za-z0-9+#. _-]{0,19}|[ァ-ヶー]{2,15})\s*[（(]\s*約?\s*([0-9０-９]+)\s*年/)
      if (pm) {
        const name = cleanSkillName(pm[1])
        const yrs = parseInt(pm[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
        if (!isNaN(yrs) && yrs >= 1 && yrs <= 40 && !isNonSkill(name)) {
          result[name] = Math.max(result[name] ?? 0, yrs * 12)
        }
      }
    }
  }

  // パターン4: Word文書の箇条書き形式「● Java　5年」「・Python　3年」「▪ AWS　2年」
  // 行頭に箇条書き記号 + スキル名 + スペース/タブ + N年  （コロン・括弧なし）
  // スペース区切り誤爆を防ぐため行頭記号必須とする
  const patternBullet = /^[●•・▪▶◆■○◇►➤※→]\s*([A-Za-z][A-Za-z0-9+#. _/-]{0,29}|[ァ-ヶー]{2,15}|[一-龯々]{2,10}(?:[　 ][A-Za-z0-9+#.]{1,15})?)\s*[　 \t]+([0-9０-９]+年(?:[0-9０-９]+[ヶかカ]?月?)?)/gm
  while ((m = patternBullet.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name) && !(name in result)) {
      result[name] = months
    }
  }

  // パターン5: 「スキル名　N年」行（行末が年数・タブ/全角スペース区切り）
  // Word職務経歴書の表形式テキスト化で見られる「Java\t5年」「Python　3年以上」
  // 誤爆防止: 行頭がスキル名のみ（先行テキストなし）かつ後続に余分なテキストがない行に限定
  const patternTabYear = /^([A-Za-z][A-Za-z0-9+#. _/()-]{1,29}|[ァ-ヶー]{2,15})\t([0-9０-９]+年[0-9０-９]*[ヶかカ]?月?(?:以上|程度|超)?)\s*$/gm
  while ((m = patternTabYear.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name) && !(name in result)) {
      result[name] = months
    }
  }

  // パターン6: 総経験年数ラベル（「経験年数：N年」「IT経験：N年以上」「経験N年」）
  // → スキルと対応しないため _totalProjectMonths に収める
  const patternTotalExp = /(?:経験年数|IT経験|総経験|開発経験)[：:]\s*([0-9０-９]+)\s*年/g
  while ((m = patternTotalExp.exec(text)) !== null) {
    const yrs = parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    if (!isNaN(yrs) && yrs >= 1 && yrs <= 50 && !result['_totalProjectMonths']) {
      result['_totalProjectMonths'] = yrs * 12
    }
  }

  // パターン7: 「参画期間: YYYY年M月 〜 YYYY年M月」+ 近傍の「使用技術: スキル1/スキル2」
  // Word職務経歴書のプレーンテキスト形式（表なし）に対応
  // 行単位で「参画期間」ラベル + 日付範囲を探し、前後10行の「使用技術」行からスキルを取得
  {
    const lines = text.split(/\n/)
    const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1
    const parseYMBody = (s: string): number | null => {
      const m3 = s.match(/(\d{4})年(\d{1,2})月/)
      if (m3) return parseInt(m3[1]) * 12 + parseInt(m3[2])
      const m4 = s.match(/(\d{4})[\/\-.](\d{1,2})/)
      if (m4) return parseInt(m4[1]) * 12 + parseInt(m4[2])
      if (/現在|今|継続|在籍中/i.test(s)) return nowYM
      return null
    }
    const PERIOD_LABEL = /^(参画期間|在籍期間|稼働期間|作業期間|プロジェクト期間|PJ期間|期間)[：:]/
    const SKILL_LABEL = /^(使用技術|使用言語|技術スタック|技術環境|開発環境|使用環境|言語|環境|スキル)[・・（(]?[^：:]*[：:]\s*(.+)/
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim()
      if (!PERIOD_LABEL.test(line)) continue
      // 期間を解析
      const periodStr = line.replace(PERIOD_LABEL, '').trim()
      const rangeM = periodStr.match(/(.+?)\s*[〜～~\-－]+\s*(.+)/)
      if (!rangeM) continue
      const startYM = parseYMBody(rangeM[1])
      const endYM = parseYMBody(rangeM[2])
      if (!startYM || !endYM) continue
      const months = endYM - startYM + 1
      if (months <= 0 || months > 600) continue
      // 前後10行で使用技術行を探す
      for (let di = -2; di <= 10; di++) {
        const sline = lines[li + di]?.trim() ?? ''
        const sm = sline.match(SKILL_LABEL)
        if (!sm) continue
        const skillStr = sm[2] ?? ''
        const skills = skillStr.split(/[\s\/／、，,・]+/).map(s => s.replace(/[（(][^）)]*[）)]/g, '').trim()).filter(s => s.length >= 2 && s.length <= 40 && !/^\d+$/.test(s))
        for (const skill of skills) {
          if (!isNonSkill(skill)) {
            result[skill] = (result[skill] ?? 0) + months
          }
        }
      }
    }
  }

  // パターン8: Word職務経歴書の「YYYY~YYYY /会社名：...【言語】A B C【OS】D E...」形式
  // 年代範囲（YYYY~YYYY または YYYY年M月～YYYY年M月）+ 【言語】【OS】【DB】【ツール】等のインライン埋め込み
  {
    const lines = text.split(/\n/)
    const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1
    // 年月パーサー（YYYY年M月, YYYY/M, YYYY.M, YYYY~YYYY の開始年のみ等）
    const parseYMSimple = (s: string): number | null => {
      const m1 = s.match(/(\d{4})年(\d{1,2})月/)
      if (m1) return parseInt(m1[1]) * 12 + parseInt(m1[2])
      const m2 = s.match(/(\d{4})[\/\-.:](\d{1,2})/)
      if (m2) return parseInt(m2[1]) * 12 + parseInt(m2[2])
      const m3 = s.match(/^(\d{4})$/)
      if (m3) return parseInt(m3[1]) * 12  // 年のみは1月扱い
      if (/現在|今|継続|在籍中|就業中/i.test(s)) return nowYM
      return null
    }
    // 行またはブロック内の【XXX】タグの後続テキストからスキルを収集
    const extractInlineTagSkills = (segment: string): string[] => {
      const skills: string[] = []
      // 【言語】【OS】【DB】【ツール】【FW】等のタグ後のスキル列
      const tagPattern = /【(?:言語|OS|DB|ツール|FW|フレームワーク|ミドル|MW|クラウド|インフラ|環境|開発環境|使用技術|技術)】([^【\n]{2,200})/g
      let tm: RegExpExecArray | null
      while ((tm = tagPattern.exec(segment)) !== null) {
        // スペース/スラッシュ/読点で分割
        const parts = tm[1].split(/[\s　\/／,、・]+/)
        for (const p of parts) {
          const s = p.replace(/[（(][^）)]*[）)]/g, '').trim()
          if (s.length >= 2 && s.length <= 40 && !/^\d+$/.test(s)) skills.push(s)
        }
      }
      return skills
    }

    // ブロック区切りのない連結行を含む処理: 各行でまず年代範囲を検出し、
    // その行（またはその行を含む前後数行）に【言語】等がある場合にスキルを抽出
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      // 年代範囲を含む行を検出 (YYYY~YYYY or YYYY年M月～YYYY年M月)
      const rangeMatch = line.match(/(\d{4}(?:年\d{1,2}月)?)\s*[〜～~\-－]+\s*(\d{4}(?:年\d{1,2}月)?|現在|今|継続|在籍中|就業中)/)
      if (!rangeMatch) continue
      const startYM = parseYMSimple(rangeMatch[1])
      const endYM = parseYMSimple(rangeMatch[2])
      if (!startYM || !endYM) continue
      const months = Math.max(1, endYM - startYM + 1)
      if (months <= 0 || months > 600) continue

      // この行と前後5行を連結してタグを検索
      const segment = lines.slice(Math.max(0, li), Math.min(lines.length, li + 6)).join(' ')
      if (!segment.includes('【')) continue
      const skills = extractInlineTagSkills(segment)
      for (const skill of skills) {
        if (!isNonSkill(skill)) {
          result[skill] = (result[skill] ?? 0) + months
        }
      }
    }

    // パターン8c: T.S型「MM/DD/YY 開始 + 【言語】ブロック + MM/DD/YY 終了 + N年Nヶ月」形式
    // 各行でMM/DD/YY（または類似）日付を見つけ、前後のセグメントに【言語】等があれば収集
    // 期間は明示された「N年Nヶ月」「（Nヶ月）」「Nヶ月間」テキストから取得
    {
      // 【言語】等を含む行のインデックスを収集
      const tagLineIdxs: number[] = []
      for (let li = 0; li < lines.length; li++) {
        if (/【(?:言語|OS|DB|ツール|FW|フレームワーク|ミドル|MW|クラウド|インフラ|環境|開発環境|使用技術|技術)】/.test(lines[li])) {
          tagLineIdxs.push(li)
        }
      }
      // 各タグブロックについて前後20行で明示的な期間テキストを探す
      for (const tli of tagLineIdxs) {
        // 前後のセグメントを連結
        const segStart = Math.max(0, tli - 5)
        const segEnd = Math.min(lines.length, tli + 20)
        const segLines = lines.slice(segStart, segEnd)
        const segText = segLines.join(' ')
        // 明示的な期間を探す（N年Nヶ月、Nヶ月間、(Nヶ月)等）
        let blockMonths = 0
        const durPatterns = [
          /(\d+)年(\d+)[ヶかカヵｶ]月/,
          /(\d+)[ヶかカヵｶ]月間/,
          /（(\d+)ヶ月）/,
          /\((\d+)ヶ月\)/,
          /(\d+)ヶ月/,
        ]
        for (const dp of durPatterns) {
          const dm = segText.match(dp)
          if (dm) {
            if (dp.toString().includes('年')) {
              blockMonths = parseInt(dm[1]) * 12 + parseInt(dm[2] ?? '0')
            } else {
              blockMonths = parseInt(dm[1])
            }
            if (blockMonths >= 1 && blockMonths <= 600) break
          }
        }
        if (!blockMonths) continue  // 期間が不明なブロックはスキップ
        // このブロックのスキルを収集
        const skills = extractInlineTagSkills(segText)
        for (const skill of skills) {
          if (!isNonSkill(skill)) {
            // 同一スキルが既に登録されている場合は最大値を取る（重複ブロックを避ける）
            result[skill] = Math.max(result[skill] ?? 0, blockMonths)
          }
        }
      }
    }

    // パターン8b: S.H型「数字: 期間 + 環境列（スペース区切り）」形式
    // 例: "1：2024年10月 ～2026年07月 ... EXADATAORACLE Linux8Oracle19c..."
    // 期間：ラベルを含む行の後続数行に技術名がスペース区切りで並ぶ場合
    const PERIOD_LABEL_2 = /(\d{4}年\d{1,2}月\s*[〜～~]+\s*(?:\d{4}年\d{1,2}月|現在|就業中))/
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      // "番号: YYYY年M月 ～ YYYY年M月" または "期間：YYYY年M月 ～ YYYY年M月" 形式
      if (!/^\d+[：:]\s*\d{4}年|^期間[：:]\s*\d{4}年/.test(line.trim())) continue
      const pm = line.match(PERIOD_LABEL_2)
      if (!pm) continue
      const parts = pm[1].split(/[〜～~]+/)
      const startYM = parseYMSimple(parts[0].trim())
      const endYM = parseYMSimple(parts[1]?.trim() ?? '')
      if (!startYM || !endYM) continue
      const months = Math.max(1, endYM - startYM + 1)
      if (months <= 0 || months > 600) continue
      // 同行〜次8行にある技術名を収集（"Linux(RHEL8)"、"Oracle19c"のような形）
      const segment = lines.slice(li, Math.min(lines.length, li + 9)).join(' ')
      // skill_masterに登録されているような技術名: 先頭大文字または英数字で始まるトークン
      const techTokens = segment.split(/[\s　]+/)
      for (const tok of techTokens) {
        const clean = tok.replace(/[（(][^）)]*[）)]/g, '').replace(/[,、・。]+$/, '').trim()
        if (clean.length >= 2 && clean.length <= 40 && /^[A-Z]/.test(clean) && !/^\d/.test(clean) && !/^[A-Z]{1}$/.test(clean)) {
          if (!isNonSkill(clean)) {
            result[clean] = (result[clean] ?? 0) + months
          }
        }
      }
    }
  }

  if (Object.keys(result).length > 0) {
    console.log(`[skillYears-body] count=${Object.keys(result).length} keys=${Object.keys(result).join(',')}`)
  }
  return filterSkillYears(result)
}

function dedupeTrimmedSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return []
  return Array.from(
    new Map(
      skills
        .map((s) => String(s).trim())
        .filter((s) => s.length > 0)
        .map((s) => [s.toLowerCase(), s]),
    ).values(),
  )
}

/** 案件内容からマッチングウェイトを自動計算（フロントの calcProjectWeights と同ロジック） */
function calcProjectWeightsForEdge(project: {
  title?: string | null
  description?: string | null
  role_summary?: string | null
  required_skills?: string[]
  remote_policy?: string | null
}): { skill: number; exp: number; rate: number; location: number; remote: number } {
  const req = project.required_skills ?? []
  const fullText = [project.title, project.description, project.role_summary].filter(Boolean).join(' ')
  let skill = 40
  const hasLanguageSkill = req.some((s) => /英語|中国語|韓国語|語学|通訳|翻訳|TOEIC|英検/.test(s))
  if (hasLanguageSkill) skill += 15
  else if (req.length >= 5) skill += 10
  else if (req.length <= 2) skill -= 5
  let exp = 15
  if (/経験年数不問|未経験可|第二新卒|経験問わ/.test(fullText)) exp = 5
  else if (/\d+年以上|\d+年超|ベテラン|シニア/.test(fullText)) exp = 20
  let remote = 10
  const isFullRemote = /フルリモート|完全リモート|100[%％]リモート/.test(project.remote_policy ?? '')
  const hasRemote = /リモート|在宅/.test(project.remote_policy ?? '')
  if (isFullRemote) remote = 20
  else if (!hasRemote) remote = 5
  let location = 20
  if (isFullRemote) location = 10
  const rate = Math.max(5, 100 - skill - exp - location - remote)
  return { skill, exp, rate, location, remote }
}

/** Gemini の案件JSONが「空」とみなせるか（配列は全要素が空なら空） */
function isProjectAIResultEmpty(result: unknown): boolean {
  if (Array.isArray(result)) {
    if (result.length === 0) return true
    return result.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true
      const o = item as Record<string, unknown>
      const req = Array.isArray(o.requiredSkills) ? o.requiredSkills : []
      const nice = Array.isArray(o.niceToHaveSkills) ? o.niceToHaveSkills : []
      const desc = o.description
      const hasDesc = typeof desc === 'string' && desc.trim().length > 0
      return req.length === 0 && nice.length === 0 && !hasDesc
    })
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return true
  const o = result as Record<string, unknown>
  const req = Array.isArray(o.requiredSkills) ? o.requiredSkills : []
  const nice = Array.isArray(o.niceToHaveSkills) ? o.niceToHaveSkills : []
  const desc = o.description
  const hasDesc = typeof desc === 'string' && desc.trim().length > 0
  return req.length === 0 && nice.length === 0 && !hasDesc
}

/** 単一オブジェクトまたは配列を案件オブジェクトの配列に正規化 */
function normalizeToProjectObjects(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter((item): item is Record<string, unknown> =>
      item != null && typeof item === 'object' && !Array.isArray(item)
    )
  }
  if (result != null && typeof result === 'object' && !Array.isArray(result)) {
    return [result as Record<string, unknown>]
  }
  return []
}

/** true のとき FATAL でも HTTP 200（JSON は ok:false）。Make のシナリオ全体停止を避ける */
function isInboundMakeSoftFail(): boolean {
  return (Deno.env.get('INBOUND_MAKE_SOFT_FAIL') ?? '').toLowerCase() === 'true'
}



// ── skill_master DB照合（AIなし・高速） ──────────────────────────────────

/** skill_master DB エントリ */
interface SkillMasterEntry { id: string; name: string; category: string; aliases: string[] }

/** Edge Function 起動中は5分間キャッシュ */
let _skillDbCache: SkillMasterEntry[] | null = null
let _skillDbCacheExpiry = 0

async function getSkillMasterFromDb(
  supabase: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>,
): Promise<SkillMasterEntry[]> {
  if (_skillDbCache && Date.now() < _skillDbCacheExpiry) return _skillDbCache
  try {
    const { data } = await supabase.from('skill_master').select('id, name, category, aliases')
    _skillDbCache = (data ?? []).map((s: Record<string, unknown>) => ({
      id: s.id as string,
      name: s.name as string,
      category: s.category as string,
      aliases: Array.isArray(s.aliases) ? (s.aliases as string[]) : [],
    }))
    _skillDbCacheExpiry = Date.now() + 5 * 60 * 1000
  } catch (e) {
    console.warn('[skill_master] DB取得失敗、空配列で続行:', String(e))
    _skillDbCache = []
    _skillDbCacheExpiry = Date.now() + 60 * 1000 // 1分後に再試行
  }
  return _skillDbCache!
}

/** skill_master の名前＋エイリアスを小文字 Set で保持（inSkillDeepDive 判定用） */
let _skillNameSet: Set<string> | null = null
let _skillNameSetExpiry = 0

/** skill_master のスキル名 Set を返す。getSkillMasterFromDb のキャッシュを流用 */
function getSkillNameSet(masterSkills: SkillMasterEntry[]): Set<string> {
  if (_skillNameSet && Date.now() < _skillNameSetExpiry) return _skillNameSet
  const s = new Set<string>()
  for (const entry of masterSkills) {
    s.add(entry.name.toLowerCase().replace(/\s+/g, ''))
    for (const alias of entry.aliases) {
      s.add(alias.toLowerCase().replace(/\s+/g, ''))
    }
  }
  _skillNameSet = s
  _skillNameSetExpiry = Date.now() + 5 * 60 * 1000
  return s
}

/**
 * テキストから skill_master エントリを照合してスキルを抽出する。
 * マッチしたスキルをテキストから除去した残テキストも返す。
 */
/**
 * テキスト中の「資格」見出し周辺（後方 windowSize 文字）を抽出する。
 * 保有資格・取得資格・資格一覧・資格・免許 等のヘッダ直後の行を対象にする。
 * 見出しが見つからない場合は空文字を返す（→ 資格マッチをスキップ）。
 */
function extractCertContext(text: string, windowSize = 500): string {
  const markers = ['保有資格', '取得資格', '資格・免許', '免許・資格', '資格一覧', '資格情報', '資格欄', '資格']
  const contexts: string[] = []
  for (const marker of markers) {
    let searchFrom = 0
    while (searchFrom < text.length) {
      const pos = text.indexOf(marker, searchFrom)
      if (pos === -1) break
      contexts.push(text.slice(pos, Math.min(pos + marker.length + windowSize, text.length)))
      searchFrom = pos + 1
    }
    if (contexts.length > 0) break // 最初に見つかったマーカーだけ使えば十分
  }
  return contexts.join('\n')
}

/**
 * テキストから URL を除去する。
 *
 * URL の path 部に含まれる "cc.php" や "https" 自体がスキル名のエイリアスに
 * マッチしてしまうケース（PHP / HTTPS の false positive）を防ぐためのヘルパー。
 * Google Drive など別の URL 検出ロジックはこの関数より前段で済んでいる前提。
 */
export function stripUrlsForSkillMatching(text: string): string {
  if (!text) return text
  return text.replace(/https?:\/\/[^\s\u3000<>"'\(\)\[\]｝】、，。]+/gi, ' ')
}

/**
 * メール末尾の送信者署名ブロックを除去する。
 *
 * 「━━━」「───」「===」等の長い区切り線で囲まれた領域は送信者署名とみなし、
 * 都道府県判定（送信者所在地の "東京都町田市" を候補者の都道府県と誤判定する問題）
 * の対象から除外するためのヘルパー。
 *
 * 区切り線が見つからない場合は元のテキストをそのまま返す。
 */
export function stripSenderSignature(text: string): string {
  if (!text) return text
  const lines = text.split(/\r?\n/)
  // 区切り線（東罫線・水平線・等号など8文字以上連続）を境界とみなす
  const separatorRe = /[━─=＝]{8,}/
  for (let i = 0; i < lines.length; i++) {
    if (separatorRe.test(lines[i])) {
      // 区切り線が本文中盤以前にあれば、それを境界とせず無視する
      // （末尾署名は通常テキスト全体の後半 60% 以降に出現する）
      if (i / lines.length >= 0.5) {
        return lines.slice(0, i).join('\n')
      }
    }
  }
  return text
}

/**
 * 駅名 → 都道府県マッピング。
 *
 * 送信者署名に書かれた会社所在地（多くは東京都）と候補者の所在地が混在する場合に、
 * 「最寄駅」から都道府県を逆引きして優先採用するための辞書。
 *
 * 全国の駅を網羅するのは現実的でないため、東京近郊で東京都と誤判定されやすい
 * 千葉・埼玉・神奈川の主要駅、および首都圏外の主要都市駅を中心に登録する。
 */
const STATION_TO_PREFECTURE: Record<string, string> = {
  // 千葉県
  '八街': '千葉県', '佐倉': '千葉県', '成東': '千葉県', '東金': '千葉県',
  '館山': '千葉県', '木更津': '千葉県', '茂原': '千葉県', '銚子': '千葉県',
  '柏': '千葉県', '松戸': '千葉県', '市川': '千葉県', '船橋': '千葉県',
  '津田沼': '千葉県', '稲毛': '千葉県', '海浜幕張': '千葉県', '幕張': '千葉県',
  '蘇我': '千葉県', '千葉': '千葉県', '本千葉': '千葉県', '西船橋': '千葉県',
  '南船橋': '千葉県', '新浦安': '千葉県', '浦安': '千葉県', '舞浜': '千葉県',
  '我孫子': '千葉県', '流山': '千葉県', '野田': '千葉県', '勝浦': '千葉県',
  '成田': '千葉県', '成田空港': '千葉県', '佐原': '千葉県', '東松戸': '千葉県',
  // 埼玉県
  '大宮': '埼玉県', '浦和': '埼玉県', '川口': '埼玉県', '所沢': '埼玉県',
  '熊谷': '埼玉県', '川越': '埼玉県', '春日部': '埼玉県', '越谷': '埼玉県',
  '草加': '埼玉県', '南越谷': '埼玉県', '新越谷': '埼玉県', '蕨': '埼玉県',
  '武蔵浦和': '埼玉県', '北浦和': '埼玉県', '西川口': '埼玉県', '志木': '埼玉県',
  '朝霞': '埼玉県', '和光市': '埼玉県', '小手指': '埼玉県',
  // 神奈川県
  '横浜': '神奈川県', '川崎': '神奈川県', '武蔵小杉': '神奈川県', '新横浜': '神奈川県',
  '関内': '神奈川県', '桜木町': '神奈川県', '上大岡': '神奈川県', '戸塚': '神奈川県',
  '藤沢': '神奈川県', '六会日大前': '神奈川県', '茅ヶ崎': '神奈川県', '平塚': '神奈川県', '小田原': '神奈川県',
  '鎌倉': '神奈川県', '逗子': '神奈川県', '横須賀': '神奈川県', '本厚木': '神奈川県',
  '海老名': '神奈川県', '相模大野': '神奈川県', '町田': '神奈川県', // 町田駅は東京都だが署名誤検出回避目的
  '鶴見': '神奈川県', '大船': '神奈川県', '東神奈川': '神奈川県',
  '元住吉': '神奈川県', '日吉': '神奈川県', '綱島': '神奈川県', '青葉台': '神奈川県',
  'たまプラーザ': '神奈川県', '溝の口': '神奈川県', '武蔵中原': '神奈川県', '登戸': '神奈川県',
  '向ヶ丘遊園': '神奈川県', '川崎大師': '神奈川県', '矢向': '神奈川県',
  // 東京都（一部・駅名から判定しやすいもの）
  '大森': '東京都', '蒲田': '東京都', '品川': '東京都', '五反田': '東京都',
  '大崎': '東京都', '目黒': '東京都', '恵比寿': '東京都', '渋谷': '東京都',
  '新宿': '東京都', '池袋': '東京都', '上野': '東京都', '秋葉原': '東京都',
  '東京': '東京都', '有楽町': '東京都', '神田': '東京都', '浜松町': '東京都',
  '田町': '東京都', '高田馬場': '東京都', '中野': '東京都', '吉祥寺': '東京都',
  '三鷹': '東京都', '立川': '東京都', '八王子': '東京都', '府中': '東京都',
  '調布': '東京都', '西調布': '東京都', '新宿西口': '東京都', '四ツ谷': '東京都',
  '飯田橋': '東京都', '水道橋': '東京都', '御茶ノ水': '東京都', '代々木': '東京都',
  '原宿': '東京都', '表参道': '東京都', '六本木': '東京都', '虎ノ門': '東京都',
  '霞ヶ関': '東京都', '日比谷': '東京都', '銀座': '東京都', '新橋': '東京都',
  '豊洲': '東京都', '門前仲町': '東京都', '錦糸町': '東京都', '亀戸': '東京都',
  '北千住': '東京都', '綾瀬': '東京都', '葛西': '東京都', '葛西臨海公園': '東京都',
  // ※ 蒲田駅（東京都大田区）→ 上記に追加済み
  // 茨城県
  '水戸': '茨城県', 'つくば': '茨城県', '土浦': '茨城県', '取手': '茨城県',
  '守谷': '茨城県', '日立': '茨城県',
  // 大阪府
  '大阪': '大阪府', '梅田': '大阪府', '難波': '大阪府', 'なんば': '大阪府',
  '天王寺': '大阪府', '新大阪': '大阪府', '京橋': '大阪府', '本町': '大阪府',
  '淀屋橋': '大阪府', '心斎橋': '大阪府', '四ツ橋': '大阪府', '肥後橋': '大阪府',
  '北浜': '大阪府', '谷町四丁目': '大阪府', '天満橋': '大阪府', 'JR福島': '大阪府',
  '西九条': '大阪府', '大正': '大阪府', '鶴橋': '大阪府', '布施': '大阪府',
  '堺筋本町': '大阪府', '阿波座': '大阪府', '中津': '大阪府', '扇町': '大阪府',
  '天満': '大阪府', '野田阪神': '大阪府', '西梅田': '大阪府', '東梅田': '大阪府',
  '豊中': '大阪府', '千里中央': '大阪府', '吹田': '大阪府', '茨木': '大阪府',
  '高槻': '大阪府', '枚方': '大阪府', '寝屋川': '大阪府',
  // 京都府
  '京都': '京都府', '河原町': '京都府', '烏丸': '京都府', '四条': '京都府',
  '烏丸御池': '京都府', '五条': '京都府', '九条': '京都府', '東山': '京都府',
  '二条': '京都府', '丸太町': '京都府', '京都駅': '京都府',
  // 兵庫県
  '神戸': '兵庫県', '三宮': '兵庫県', '元町': '兵庫県', '新神戸': '兵庫県',
  '灘': '兵庫県', '六甲道': '兵庫県', '摂津本山': '兵庫県', '住吉': '兵庫県',
  '西宮': '兵庫県', '芦屋': '兵庫県', '尼崎': '兵庫県', '宝塚': '兵庫県',
  '明石': '兵庫県', '姫路': '兵庫県', '加古川': '兵庫県',
  // 奈良・和歌山
  '奈良': '奈良県', '和歌山': '和歌山県',
  // 愛知県
  '名古屋': '愛知県', '栄': '愛知県', '金山': '愛知県', '伏見': '愛知県',
  '丸の内': '愛知県', '国際センター': '愛知県', '名古屋駅': '愛知県',
  '千種': '愛知県', '今池': '愛知県', '本山': '愛知県', '八事': '愛知県',
  '岩塚': '愛知県', '中村区役所': '愛知県', '豊橋': '愛知県', '岡崎': '愛知県',
  '一宮': '愛知県', '春日井': '愛知県', '豊田': '愛知県',
  // 中部その他
  '岐阜': '岐阜県', '静岡': '静岡県', '浜松': '静岡県',
  '長野': '長野県', '松本': '長野県', '新潟': '新潟県',
  '富山': '富山県', '金沢': '石川県', '福井': '福井県',
  // 福岡県
  '福岡': '福岡県', '博多': '福岡県', '天神': '福岡県', '小倉': '福岡県',
  '箱崎': '福岡県', '吉塚': '福岡県', '千代': '福岡県', '馬出九大病院前': '福岡県',
  '中洲川端': '福岡県', '呉服町': '福岡県', '祇園': '福岡県', '博多駅': '福岡県',
  '西新': '福岡県', '藤崎': '福岡県', '姪浜': '福岡県', '福岡空港': '福岡県',
  '北九州': '福岡県',
  // 九州その他
  '熊本': '熊本県', '鹿児島中央': '鹿児島県', '長崎': '長崎県',
  '大分': '大分県', '宮崎': '宮崎県', '佐賀': '佐賀県',
  '那覇': '沖縄県',
  // 北海道・東北
  '札幌': '北海道', 'すすきの': '北海道', '函館': '北海道', '旭川': '北海道',
  '仙台': '宮城県', '盛岡': '岩手県', '青森': '青森県', '秋田': '秋田県',
  '山形': '山形県', '福島': '福島県', '郡山': '福島県',
}

/** own_email_domain キャッシュ（undefined = 未ロード、null = 未設定） */
let _ownEmailDomain: string | null | undefined = undefined
let _ownEmailDomainLoadedAt = 0
const OWN_DOMAIN_CACHE_MS = 5 * 60 * 1000

/** app_config から own_email_domain を取得（5分キャッシュ） */
async function loadOwnEmailDomain(supabaseUrl: string, serviceKey: string): Promise<string | null> {
  const now = Date.now()
  if (_ownEmailDomain !== undefined && now - _ownEmailDomainLoadedAt < OWN_DOMAIN_CACHE_MS) {
    return _ownEmailDomain
  }
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/app_config?select=value&key=eq.own_email_domain&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    )
    if (res.ok) {
      const rows = await res.json() as { value: string }[]
      _ownEmailDomain = rows[0]?.value?.trim() || null
    }
  } catch {
    _ownEmailDomain = null
  }
  _ownEmailDomainLoadedAt = Date.now()
  return _ownEmailDomain ?? null
}

/**
 * 駅名（"八街駅" "八街" 等）からハードコードマップで都道府県を推定する。
 * 不一致時は null を返す（同期）。
 */
export function inferPrefectureFromStation(station: string | null | undefined): string | null {
  if (!station) return null
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim()
  if (!cleaned) return null
  return STATION_TO_PREFECTURE[cleaned] ?? null
}

/**
 * station_master のスナップショット（scripts/export_station_master.mjs で書き出し・
 * デプロイ物に同梱）。実行時のDB往復（egress・レイテンシ・DB障害時の欠損）を無くすため、
 * 静的importでバンドルする。DBを更新したら export_station_master.mjs を再実行してから
 * デプロイすること（sync_extractors.mjsと同じ「DBが正・デプロイ物は生成物」の思想）。
 *
 * 駅名は全国で一意ではない（例:「府中」は広島・徳島・東京に実在）ため、
 * 1駅名につき路線ごとの{line, prefecture}を複数保持する（出典: ekidata.jp実データ）。
 * 詳細設計: docs/station_prefecture_extraction_design.md
 */
import STATION_MASTER_DATA from './station_data.json' with { type: 'json' }
interface StationMasterEntry { line: string; prefecture: string }
const STATION_MASTER_MAP = STATION_MASTER_DATA as Record<string, StationMasterEntry[]>

/**
 * station_master のスナップショットに照合して都道府県を返す。
 * ハードコードマップ（STATION_TO_PREFECTURE）にない駅のフォールバック用。
 *
 * 路線名が区切りなしで駅名の前に直結している入力（例:「小田急小田原線本厚木駅」）に対応するため、
 * ①クリーニング済みフル文字列 → ②末尾の「線」以降の部分文字列、の順で駅名候補を照合する
 * （フル文字列を先に試すことで、駅名自体に「線」を含む駅＝相鉄本線・新線新宿等を壊さない）。
 *
 * 同名駅（複数都道府県に実在）の場合:
 *   - 入力から路線名候補が取れていれば、その路線と一致するエントリの都道府県を採用する
 *   - 路線名が取れず候補が複数県にまたがる場合は、誤った県を入れるより安全側で null を返す
 *     （station_prefecture_extraction_design.md §3 の方針）
 */
async function lookupStationPrefectureFromDb(station: string | null | undefined): Promise<string | null> {
  if (!station) return null
  // ヶ（小文字）→ ケ（通常）に統一（保土ヶ谷→保土ケ谷 等、DB は通常ケで登録）
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim().replace(/ヶ/g, 'ケ')
  if (!cleaned) return null

  const lastLineIdx = cleaned.lastIndexOf('線')
  const hasLineSplit = lastLineIdx >= 0 && cleaned.length - lastLineIdx - 1 >= 2
  // 「小田急小田原線」のような路線名候補（同名駅の disambiguation に使う。取れなければ null）
  const lineNameCandidate = hasLineSplit ? cleaned.slice(0, lastLineIdx + 1) : null
  const stationCandidates = hasLineSplit ? [cleaned, cleaned.slice(lastLineIdx + 1)] : [cleaned]

  for (const candidate of stationCandidates) {
    const entries = STATION_MASTER_MAP[candidate]
    if (!entries || entries.length === 0) continue
    const distinctPrefs = [...new Set(entries.map((e) => e.prefecture))]
    if (distinctPrefs.length === 1) return distinctPrefs[0]
    // 同名駅で複数都道府県にまたがる: 路線名候補があれば一致するものを優先採用
    if (lineNameCandidate) {
      const match = entries.find((e) =>
        e.line && (e.line === lineNameCandidate || e.line.includes(lineNameCandidate) || lineNameCandidate.includes(e.line)))
      if (match) return match.prefecture
    }
    // 判別できない（同名駅・路線不明）: 誤った県を入れるより安全側でnull
    return null
  }
  return null
}

/**
 * スキルシートのフェーズ表ヘッダー行を検出する。
 *
 * 添付スキルシート（Excel→CSV）には次のような行が含まれる:
 *   「調査分析\t要件定義\t基本設計\t詳細設計\t製造/構築\t単体試験\t総合試験\t運用試験\t保守/運用」
 * これを PROSE_ROLES マッチに含めると候補者の経験有無に関わらず
 * 要件定義/基本設計/詳細設計 等が一律に役割として登録されてしまう false positive を起こす。
 *
 * 厳密なフェーズ用語（"単体試験" "結合試験" など、通常の散文ではまず4語以上同時に登場しない語）を
 * 4 種類以上含む行のみフェーズ表ヘッダーとみなして除外する。
 */
const STRICT_PHASE_HEADER_KEYWORDS = [
  '調査分析', '要件定義', '基本設計', '詳細設計',
  '単体試験', '結合試験', '総合試験', '運用試験', '受入試験',
  '単体テスト', '結合テスト', '総合テスト', '受入テスト',
] as const

export function isPhaseTableHeader(line: string): boolean {
  if (!line) return false
  let count = 0
  for (const kw of STRICT_PHASE_HEADER_KEYWORDS) {
    if (line.includes(kw)) {
      count++
      if (count >= 4) return true
    }
  }
  return false
}

/**
 * テキストからスキルを照合して抽出する。
 *
 * @param text         照合対象テキスト
 * @param masterSkills スキルマスター一覧
 * @param options.looseCert
 *   false（デフォルト・メール本文用）:
 *     資格は certContext（「資格」見出し周辺）のみ照合。見出しがなければスキップ。
 *   true（添付ファイル用）:
 *     certContext が見つかれば優先使用。見つからない場合はフォーマット崩れを考慮して
 *     テキスト全体を対象に照合（全文fallback）。
 */
// スキル照合の正規表現コンパイルキャッシュ。1660スキル×別名ぶんの new RegExp を毎回作り直すと
// 名簿(複数人)メールでブロック数×1660回コンパイルし546タイムアウトになる実害があった（1-r.co.jp）。
// パターン文字列は term から決まり決定的なので、コンパイル済み RegExp を使い回す（挙動は不変）。
const _skillRegexCache = new Map<string, RegExp>()
function _cachedSkillRegex(pattern: string): RegExp {
  let re = _skillRegexCache.get(pattern)
  if (!re) { re = new RegExp(pattern, 'gi'); _skillRegexCache.set(pattern, re) }
  re.lastIndex = 0 // g フラグ付き .test() は lastIndex を進めるため毎回リセット
  return re
}

function extractAndRemoveSkills(
  text: string,
  masterSkills: SkillMasterEntry[],
  options: { looseCert?: boolean } = {},
): { matched: { name: string; category: string }[]; remaining: string } {
  const matched: { name: string; category: string }[] = []
  // URL をスペース化してから照合（PHP / HTTPS の false positive 防止）
  const cleanedText = stripUrlsForSkillMatching(text)
  let remaining = cleanedText
  const certContext = extractCertContext(cleanedText)
  const { looseCert = false } = options

  // 資格の照合対象テキストを決定
  // - certContext あり: 見出し周辺のみ（本文・添付共通）
  // - certContext なし + looseCert=false（本文）: スキップ
  // - certContext なし + looseCert=true（添付）: テキスト全体をfallback
  const certMatchTarget = certContext || (looseCert ? text : null)

  for (const skill of masterSkills) {
    const isCert = skill.category === 'certifications'
    if (isCert && !certMatchTarget) continue
    const matchTarget = isCert ? certMatchTarget! : remaining

    const terms = [skill.name, ...skill.aliases]
    for (const term of terms) {
      if (!term || term.length < 2) continue
      const escaped = term.replace(/[.+*?()[\]{}\\|^$]/g, '\\$&')

      // 純粋な英小文字のみ 2〜3 文字の語（go 等）は英語自然文と区別できないため
      // 直後が日本語文字・空白・文末の場合のみマッチさせる。
      const isShortLowerAscii = /^[a-z]{2,3}$/.test(term)
      const pattern = isShortLowerAscii
        ? `(?<![a-zA-Z0-9_#])${escaped}(?=[\\s\\u3000-\\u9FFF、。！？）」』]|$)`
        : `(?<![a-zA-Z0-9_#])${escaped}(?![a-zA-Z0-9_.])`

      const regex = _cachedSkillRegex(pattern)
      if (regex.test(matchTarget)) {
        matched.push({ name: skill.name, category: skill.category })
        if (!isCert) {
          remaining = remaining.replace(_cachedSkillRegex(pattern), ' ')
        }
        break
      }
    }
  }

  // Phase2: 2文字以下の短いスキルを区切り文字+隣接スキルコンテキストで補完
  const matchedNameSet = new Set(matched.map(m => m.name))
  for (const skill of masterSkills) {
    if (skill.name.length > 2) continue
    if (matchedNameSet.has(skill.name)) continue
    const escaped = skill.name.replace(/[.+*?()[\]{}\\|^$]/g, '\\$&')
    // 区切り文字に挟まれたパターン（キャッシュ利用・while前に lastIndex=0 リセット済み）
    const delimRe = _cachedSkillRegex(
      `(?:^|[,，/／・\\t\\n\\r])\\s*(${escaped})\\s*(?=[,，/／・\\t\\n\\r]|$)`,
    )
    let m: RegExpExecArray | null
    while ((m = delimRe.exec(cleanedText)) !== null) {
      const pos = m.index
      // 前後100文字に既マッチのスキルがあるか確認
      const ctx = cleanedText.slice(Math.max(0, pos - 100), pos + m[0].length + 100)
      if ([...matchedNameSet].some(n => n.length > 2 && ctx.includes(n))) {
        matched.push({ name: skill.name, category: skill.category })
        matchedNameSet.add(skill.name)
        break
      }
    }
  }

  return { matched, remaining: remaining.replace(/\s{2,}/g, ' ').trim() }
}

/**
 * 日本式スキルシートの評価テーブル（A/B/C/D/E 評価）を検出し、
 * D/E 評価（実務経験なし）のスキルを除外する。
 *
 * Excel を CSV 化すると評価行は  "Python,3,B"  や  "Python,,○,,,"  のようになる。
 * 行に [ABC] が standalone で含まれれば高評価、[DE] のみなら低評価と判定する。
 * スキルシート形式でない場合（評価行 <5 行）は入力をそのまま返す。
 */
function filterBySkillRating(
  text: string,
  skills: { name: string; category: string }[],
): { name: string; category: string }[] {
  if (!text.trim() || skills.length === 0) return skills

  const lines = text.split(/\r?\n/)
  // 行に独立した A〜E の 1 文字が含まれる行数でスキルシート形式かどうか判定
  const ratingLineCount = lines.filter(l => /(?:^|,|\t)\s*[ABCDE]\s*(?:,|\t|$)/.test(l)).length
  if (ratingLineCount < 5) {
    // スキルシート形式ではない → フィルターしない
    return skills
  }

  return skills.filter(skill => {
    const escaped = skill.name.replace(/[.*+?()[\]{}\\|^$]/g, '\\$&')
    const nameRe = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, 'i')
    const matchingLines = lines.filter(l => nameRe.test(l))

    if (matchingLines.length === 0) return true // 該当行なし → 保持

    // ホワイトリスト方式: いずれかの行に明示的な A/B/C が含まれる場合のみ保持
    // 空欄・D/E はいずれも除外（スキルシート形式では評価なし＝経験なしとみなす）
    return matchingLines.some(l =>
      /(?:^|,|\t)\s*[ABC]\s*(?:,|\t|$)/.test(l),
    )
  })
}

/**
 * 案件テキストから「スキル別の必要経験年数」を抽出する。
 *
 * 例: 「VB.netのプログラミング経験5年以上 または VB.netプログラミング経験2年以上かつ
 *      JavaまたはC#.netによるプログラミング経験5年以上」
 *   → { "VB.NET": [2, 5], "Java": [5], "C#.NET": [5] }
 *
 * 同一スキルが複数の年数で言及される場合（5年以上/2年以上）は全て配列で保持する。
 * スキル名（および skill_master のエイリアス）の直後 25 文字以内（数字・句点・改行を挟まない範囲）に
 * 現れる「N年」を要求年数とみなす。
 */
function extractRequiredSkillYears(
  text: string,
  requiredSkills: string[],
  masterSkills: SkillMasterEntry[],
): Record<string, number[]> {
  if (!text || requiredSkills.length === 0) return {}
  // 全角数字 → 半角
  const norm = text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))
  const aliasMap = new Map(masterSkills.map(s => [s.name, s.aliases ?? []]))
  const result: Record<string, number[]> = {}
  for (const skill of requiredSkills) {
    const terms = [skill, ...(aliasMap.get(skill) ?? [])].filter(t => t && t.length >= 2)
    const years = new Set<number>()
    for (const term of terms) {
      const escaped = term.replace(/[.+*?()[\]{}\\|^$]/g, '\\$&')
      // term の直後 25 文字以内（数字・句点・改行を挟まない）に現れる「N年」を拾う
      const re = new RegExp(`${escaped}[^。\\n0-9]{0,25}?(\\d{1,2})\\s*年`, 'gi')
      let m: RegExpExecArray | null
      while ((m = re.exec(norm)) !== null) {
        const y = parseInt(m[1], 10)
        if (y >= 1 && y <= 30) years.add(y)
      }
    }
    if (years.size > 0) result[skill] = [...years].sort((a, b) => a - b)
  }
  return result
}

/**
 * 件名から候補者内部コードを抽出する（例: "IA62", "AS400", "FE3"）
 * name=不明のとき代替名として使用
 */
function extractCandidateCode(subject: string): string | null {
  // 【直人材/ AS/400, RPG/...】のようなパターンから英数コードを抽出
  // 1〜4文字のアルファベット + 1〜3桁の数字（例: IA62, FE3, AS400, AA11）
  const codePattern = /\b([A-Z]{1,4}\d{1,3})\b/g
  const matches = [...subject.matchAll(codePattern)].map(m => m[1])
  if (matches.length > 0) return matches[0]
  return null
}


/**
 * AI不使用・正規表現で候補者名をざっくり抽出する（全AI失敗時のフォールバック用）
 * ① 「氏名：田中」「名前 佐藤」などラベル直後の値
 * ② ラベルがなければ「T・Y」「T Y」形式のイニシャル（大文字2文字＋スペースor・）のみ
 * 直後に値がなければ即 null（不明）。
 */
function extractNameFallback(text: string): string | null {
  // ① ラベル（氏名/名前等）の直後: 「氏名：田中」「【名前】K.M」「名前 佐藤」形式
  const labelMatch = text.match(
    /(?:【名前】|【氏名】|(?:氏名|名前|候補者名?|お名前|フルネーム|ご氏名)[　 ]?[：:][　 ]?)([^\n\r】、。,　 ]{1,20})/
  )
  if (labelMatch) {
    const v = labelMatch[1].trim()
    if (v && v.length >= 2) return v
  }

  // ② イニシャル: 大文字2文字の間にスペース・・.のいずれか（例: T・Y / T Y / K.M）
  // 直後が英数字でなければマッチ（】 _ スペース 末尾 等）
  // 地名・国名略称（例: 「アメリカC.A.」＝カリフォルニア州）を候補者名として誤認識しないよう除外
  const KNOWN_PLACE_ABBR = new Set(['CA', 'NY', 'UK', 'US', 'DC', 'LA', 'UAE', 'EU'])
  const initialRe = /\b([A-Z][　 ・.][A-Z])(?![a-zA-Z0-9])/g
  let initialMatch: RegExpExecArray | null
  while ((initialMatch = initialRe.exec(text)) !== null) {
    const normalized = initialMatch[1].replace(/[　 ・.]/g, '')
    if (KNOWN_PLACE_ABBR.has(normalized)) continue
    return initialMatch[1]
  }

  return null
}

/**
 * フィールド抽出ヘルパー（Phase0〜3）
 *
 * Phase0  本文ブロック絞り込み: 空行でブロック分割 → ラベルを含むブロック内で先に同行検索
 * Phase1  本文・ファイル名 全体 同一行: `ラベル[SEP]値`
 * Phase2a 添付テキスト 同一行         : `ラベル[SEP+カンマ]値`
 * Phase2b 添付テキスト 次行/テーブル  :
 *   - テーブル形式（CSV/TSV ヘッダ行）: ラベルの列インデックスで次行の対応セルを取得
 *   - 非テーブル形式: ラベルのみ行の直後行を取得
 * Phase3  全テキスト 単一半角SP区切り : 値が phase3MinLen 文字以上のみ採用
 *
 * 区切り文字 SEP: ：: \t 全角SP×1+ 半角SP×2+  （Phase0〜3共通）
 * 添付追加   ,，                                （Phase2a/2b追加）
 * 単独スペース                                  （Phase3のみ）
 */
/**
 * ラベル文字列に「単　価」「氏　名」のような全角・半角スペース挿入があってもマッチするよう、
 * 各文字の間に `[　 ]*` を挟んだ正規表現用文字列に変換する。
 *
 * メタ文字（? * + 等）は前文字に対する量指定子のため、メタ文字の直前には `[　 ]*` を挟まない。
 * メタ文字の直後には挟む（例: `最寄り?駅` → `最[　 ]*寄[　 ]*り?[　 ]*駅` で「最　寄り　駅」も拾える）。
 */
function flexLabel(label: string): string {
  const META = /[.*+?()[\]{}\\|^$]/
  let result = ''
  for (let i = 0; i < label.length; i++) {
    const ch = label[i]
    const isMeta = META.test(ch)
    result += isMeta ? ch : ch.replace(/[.*+?()[\]{}\\|^$]/g, '\\$&')
    if (i < label.length - 1) {
      const next = label[i + 1]
      const nextIsMeta = META.test(next)
      if (!nextIsMeta) result += '[　 ]*'
    }
  }
  return result
}

// Phase2bで「ラベルのみ行の直後行」を値として拾う際、直後行がこれら他フィールドの
// ラベル行（例:「年齢：31」）だった場合に誤ってその値を採用しないためのガード
const OTHER_LABEL_LINE_RE = /^[　 ]*(?:フリガナ|ふりがな|氏名|名前|お名前|年齢|性別|最寄駅|最寄り駅|最終学歴|学歴|現住所|住所|居住地|経験年数|経験|希望単価|希望月額|単価|希望稼働|稼働希望|参画時期|稼働時期|開始時期|自己PR|保有資格|資格|国籍)[　 ]?[：:]/

function extractFieldTwoPhase(
  labels: string[],
  bodyText: string,
  attachText: string,
  validate?: (v: string) => boolean,
  maxLen = 30,
  phase3MinLen = 3,
): string | null {
  const esc = labels.map(flexLabel).join('|')
  // 区切り文字。
  //   - 】 を含めることで「【単　価】65万」のような囲み記号ラベル直後に値が続くフォーマットも拾える。
  //   - ラベル直後（または半角スペース許容）にのみ ] として作用するため、本文中の単独「】」は誤検出しない。
  const SEP     = `(?:[：:\\t\\]】◆◇●■▼★]|　+| {2,})`
  const SEP_ATT = `(?:[：:\\t\\],，】◆◇●■▼★]|　+| {2,})`

  // ◆氏名◆ / ●名前● 等のデコレータ文字でラベルが囲まれているケースを正規化
  // 「◆氏名◆\nSS」→「氏名\nSS」、「◆氏名◆：SS」→「氏名：SS」
  const DECO_RE = /[◆◇●■▼★◎※▪]+([^◆◇●■▼★◎※▪\n]{1,30})[◆◇●■▼★◎※▪]+/g
  const normalBody   = bodyText.replace(DECO_RE,   (_, inner) => inner.trim())
  const normalAttach = attachText.replace(DECO_RE, (_, inner) => inner.trim())

  const check = (v: string, minLen = 1): string | null => {
    const t = v.trim().replace(/[　 ]+$/, '')
    if (!t || t.length < minLen || t.length > maxLen) return null
    if (validate && !validate(t)) return null
    return t
  }

  const rSameLine = (sep: string) =>
    // (?:（...）|(...))? — 全角括弧（氏名（フリガナ））と半角括弧（氏名(ｲﾆｼｬﾙ)）の両方を許容
    new RegExp(`(?:${esc})(?:[（(][^）)]{1,20}[）)])?[　 ]?${sep}[　 ]?[：:]?[　 ]?([^\\n,，]{1,${maxLen}})`, 'i')

  // ── Phase0: 本文ブロック絞り込み ──────────────────────────────
  // 空行2行以上でブロック分割し、ラベルを含む最初のブロック内で同行検索
  const bodyBlocks = normalBody.split(/\n{2,}/)
  if (bodyBlocks.length > 1) {
    const labelPresent = new RegExp(`(?:${esc})`, 'i')
    const block = bodyBlocks.find(b => labelPresent.test(b))
    if (block && block !== normalBody) {
      const m = block.match(rSameLine(SEP))
      if (m) { const v = check(m[1]); if (v) return v }
    }
  }

  // ── Phase1: 本文 全体 同一行 ──────────────────────────────────
  const mBody = normalBody.match(rSameLine(SEP))
  if (mBody) { const v = check(mBody[1]); if (v) return v }

  // ── Phase1b: 本文 次行（◆氏名◆\n値 等のデコレータ付きラベル対応） ──
  {
    // ラベル直後の括弧書き注釈（「氏 名（ﾌﾘｶﾞﾅ）」等）も許容してからラベル単独行と判定する
    const labelOnly1b = new RegExp(`^[　 ]*[■●▪▶【]?[　 ]?(?:${esc})(?:[（(][^）)]{1,20}[）)])?[　 ]?[】：:,，]?[　 ]*$`, 'i')
    const bodyLines = normalBody.split(/\r?\n/)
    for (let i = 0; i < bodyLines.length - 1; i++) {
      if (!labelOnly1b.test(bodyLines[i])) continue
      for (let j = i + 1; j < Math.min(i + 3, bodyLines.length); j++) {
        const v = check(bodyLines[j])
        if (v) return v
      }
    }
  }

  if (normalAttach.trim()) {
    // ── Phase2a: 添付 同一行 ──────────────────────────────────
    const mAtt = normalAttach.match(rSameLine(SEP_ATT))
    if (mAtt) { const v = check(mAtt[1]); if (v) return v }

    // ── Phase2b: 添付 次行 / テーブル構造 ────────────────────
    const lines = normalAttach.split(/\r?\n/)
    const labelExact = new RegExp(`^(?:${esc})$`, 'i')   // 完全一致（テーブルヘッダ用）
    // ラベル直後の括弧書き注釈（「氏 名（ﾌﾘｶﾞﾅ）」等）も許容
    const labelOnly  = new RegExp(`^[　 ]*(?:${esc})(?:[（(][^）)]{1,20}[）)])?[　 ]?[：:,，]?[　 ]*$`, 'i') // ラベルのみ行

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]
      const labelPresent = new RegExp(`(?:${esc})`, 'i')
      if (!labelPresent.test(line)) continue

      // テーブル形式: カンマ or タブ区切りで複数セルある場合
      const sep = line.includes('\t') ? /\t/ : /,/
      const headers = line.split(sep).map(h => h.trim())
      if (headers.length > 1) {
        const colIdx = headers.findIndex(h => labelExact.test(h))
        if (colIdx !== -1) {
          // ヘッダ行確定 → 次のデータ行の同列セルを取得
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const dataLine = lines[j].trim()
            if (!dataLine) continue
            const cells = dataLine.split(sep).map(c => c.trim())
            if (cells[colIdx]) {
              const v = check(cells[colIdx])
              if (v) return v
            }
            break // データ行は1行のみ試行
          }
          continue
        }
      }

      // 非テーブル: ラベルのみ行の直後行
      // ※ Excelの結合セル崩れ等で本来の値が失われ「ラベルのみ行」になった場合、
      //   直後行が「別の既知ラベル：値」（例:「年齢：31」）だと誤って自分の値として
      //   拾ってしまう（実例: 氏名の値が「年齢：31」になる）。次行が他フィールドの
      //   ラベル行なら、このラベルの値は取得不可として諦める。
      if (labelOnly.test(line)) {
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          if (OTHER_LABEL_LINE_RE.test(lines[j])) break
          const v = check(lines[j])
          if (v) return v
        }
      }
    }
  }

  // ── Phase3: 単一半角スペース区切り（最終フォールバック） ──────
  const allText = normalBody + '\n' + normalAttach
  const rSingle = new RegExp(`(?:${esc}) ([^ \\t,，\\n　]{1,${maxLen}})`, 'i')
  const mSingle = allText.match(rSingle)
  if (mSingle) { const v = check(mSingle[1], phase3MinLen); if (v) return v }

  return null
}

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
  '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
  '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
  '熊本県','大分県','宮崎県','鹿児島県','沖縄県',
]

/**
 * AI抽出が空だった項目を正規表現で2段階補完する（人材メール用）。
 * bodyText = 件名+本文+ファイル名、attachText = 添付テキスト。
 */
function extractCandidateFieldsRegex(
  bodyText: string,
  attachText: string,
): {
  name: string | null
  age: number | null
  gender: string | null
  nationality: string | null
  nearestStation: string | null
  prefecture: string | null
  experienceYears: number | null
  // 「経験年数：」「実務経験：」等の専用ラベルからの明示的な自己申告値かどうか。
  // trueの場合、Excel添付の日付スパン推定（前職期間等を含み過大評価しやすい）で
  // 安易に上書きしないための判定に使う。
  experienceYearsIsDedicated: boolean
  desiredRate: string | null
  availableFrom: string | null
  desiredProject: string | null
  fromCompany: string | null
  nameSkillYears: Record<string, number> | null
} {
  // ── 氏名 ──────────────────────────────────────────────────────
  // Phase3 は日本語の姓名（2文字〜）も有効なので phase3MinLen=2
  // Excel添付のヘッダ行「氏名,年齢,性別...」から Phase2a が「年齢」等を拾う誤抽出を防ぐため
  // フィールドラベル名として一般的な語は名前として採用しない
  const NAME_FIELD_LABELS = /^(年齢|性別|住所|スキル|経験|希望|単価|国籍|備考|資格|学歴|連絡先|電話|メール|生年|誕生|担当|会社|企業|所属|役職|部署|稼働|稼動|勤務|現住所|最寄|最寄り|駅名|沿線|フリガナ|ふりがな|読み|備考欄|コメント|評価|合計|レベル|スコア|期間|開始|終了|工程|規模|人数|契約|派遣|フリー|正社員|アルバイト|パート)$/
  let rawName = extractFieldTwoPhase(
    ['氏名等','氏名','名前','候補者名','お名前','フルネーム','ご氏名','氏　名','技術者名','技術者氏名','イニシャル'],
    bodyText, attachText,
    // 「性　別」「氏　名」のように全角スペースを挟んで表記されたラベル語も除外対象にする
    // （Excel結合セル崩れで隣の「性別」ラベル自体を氏名の値として誤って拾うケース）
    v => v.length >= 2 && !/^\d+$/.test(v) && !NAME_FIELD_LABELS.test(v.replace(/[\s　]/g, '')),
    40,
    2,
  )
  // カンマ区切りイニシャル補完: extractFieldTwoPhase は , を終端文字として扱うため
  // 「名前：M,T（23）」→ rawName=null になる。元テキストで「X,Y」を探してドット形式に補完。
  if (!rawName) {
    const commaInitialM = (bodyText + '\n' + attachText).match(
      /(?:氏名等|氏名|名前|候補者名?|お名前|フルネーム|ご氏名|氏[　 ]*名)[　 ]*[：:][　 ]*([A-Z]),([A-Z])/
    )
    if (commaInitialM) rawName = `${commaInitialM[1]}.${commaInitialM[2]}`
  }
  // 末尾コロン除去後に NAME_FIELD_LABELS に該当するものを除外（例: 「性別：」→ null）(#92)
  if (rawName) {
    const strippedColon = rawName.replace(/[：:　\s]+$/, '').trim()
    if (NAME_FIELD_LABELS.test(strippedColon.replace(/[\s　]/g, ''))) rawName = null
  }
  // 値全体が「ラベル：値」形式で、ラベル部分が個人情報ラベルの場合も除外
  // （例: 隣接する別ラベル行を氏名の値として誤って拾った「性別：男」等）
  if (rawName) {
    const labelPrefixMatch = rawName.match(/^([^\s　：:]{1,10})[：:]/)
    if (labelPrefixMatch && NAME_FIELD_LABELS.test(labelPrefixMatch[1])) rawName = null
  }
  // テンプレートプレースホルダー「イニシャル（性別、年齢）」等を名前として採用しない (#92)
  if (rawName && /^イニシャル/.test(rawName.trim())) rawName = null
  // 先頭の区切り文字（：: 等）を除去（「：T.B（27）」→「T.B（27）」）
  let cleanedName = rawName ? rawName.replace(/^[：:\s　]+/, '').trim() || null : null
  // イニシャル後の余分な説明文を除去:
  //   "N.S顧客折衝～ベンダー調整可能なエンジニア！" → "N.S"
  //   "NK（長野に引っ越し予定）" → "NK"
  //   "K.Y　サブリーダーあり" → "K.Y"
  // 条件: イニシャルパターン（X.Y / XX）が先頭にあり、全体がイニシャルより明らかに長い場合のみ
  // ただし「A.S（25）男性」のような年齢・性別の構造化情報は「余分な説明文」ではないため
  // 除去対象から除外する（除去すると直後の年齢・性別抽出が丸ごと失敗し、経験年数の
  // 年齢フォールバックも効かなくなる致命的な事故になる）
  if (cleanedName) {
    const initM = cleanedName.match(/^([A-Za-zＡ-Ｚａ-ｚ][.\s　・]*[A-Za-zＡ-Ｚａ-ｚ](?:[.\s　・]*[A-Za-zＡ-Ｚａ-ｚ])?)/)
    if (initM && cleanedName.length > initM[1].length + 2) {
      const remainder = cleanedName.slice(initM[1].length)
      const looksLikeAgeSuffix = /^[\s　]*[\(（]\d{2}[才歳]?[\)）]?/.test(remainder)
      if (!looksLikeAgeSuffix) {
        cleanedName = initM[1]
      }
    }
  }
  // 名前から年齢・性別を抽出して除去
  // パターン1: (34歳/男性) (34才/女性) - スラッシュ区切り一体型
  // パターン2: 56才(男性) - 分離型
  let age: number | null = null
  let gender: string | null = null
  let nameStripped = cleanedName || ''
  // パターンA: (26歳/男性) (26歳/男性/日本) (26歳：男性) — 年齢が先・末尾に/国籍等があっても可
  const agGenderUnified = nameStripped.match(/[\(（](\d{2})[才歳][ 　]*[/／：:・．][ 　]*(男性|女性|男|女)(?:[/／]([^)）]*))?[\)）]/)
  // パターンB: (男性/40歳) (女性/34歳) (男性：51歳) — 性別が先、/や：区切り
  // 「（男性/48歳、中国）」のように括弧内に国籍が続く形式にも対応
  const genderAgeUnified = !agGenderUnified ? nameStripped.match(/[\(（](男性|女性|男|女)[ 　]*(?:[/／：:・．][ 　]*|[ 　]+)(\d{2})[才歳](?:[、,\/／]([^)）]{1,15}))?[\)）]/) : null
  let nationality: string | null = null
  if (agGenderUnified) {
    age = parseInt(agGenderUnified[1], 10)
    gender = agGenderUnified[2]
    if (agGenderUnified[3]?.trim()) nationality = agGenderUnified[3].trim()
    nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[才歳][ 　]*[/／：:・．][ 　]*(?:男性|女性|男|女)(?:[/／][^)）]*)?[\)）]/, '').trim()
  } else if (genderAgeUnified) {
    gender = genderAgeUnified[1]
    age = parseInt(genderAgeUnified[2], 10)
    if (genderAgeUnified[3]?.trim() && !nationality) nationality = genderAgeUnified[3].trim()
    nameStripped = nameStripped.replace(/[\s　]?[\(（](?:男性|女性|男|女)[ 　]*(?:[/／：:・．][ 　]*|[ 　]+)\d{2}[才歳](?:[、,\/／][^)）]{1,15})?[\)） ]/, '').trim()
  } else {
    // スペースなしで括弧が直後に来るケース: YS(26歳) → スペース不要で拾う
    const ageMatch = nameStripped.match(/[\s　]?[\(（](\d{2})[才歳][\)）]?/)
    if (ageMatch) {
      age = parseInt(ageMatch[1], 10)
      nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[才歳][\)）]?/, '').trim()
    }
    const genderMatch = nameStripped.match(/[\s　]?[\(（](男性|女性|男|女)[\)）]/)
    if (genderMatch) {
      gender = genderMatch[1]
      nameStripped = nameStripped.replace(/[\s　]?[\(（](?:男性|女性|男|女)[\)）]/, '').trim()
    }
    // 括弧なしで末尾に gender が残るケース: K.T（32才）女性 → K.T
    if (gender === null) {
      const bareGenderMatch = nameStripped.match(/[ 　]?(男性|女性|男|女)$/)
      if (bareGenderMatch) {
        gender = bareGenderMatch[1]
        nameStripped = nameStripped.replace(/[ 　]?(?:男性|女性|男|女)$/, '').trim()
      }
    }
    // 括弧付き2桁数字（才歳なし）の年齢除去: T.N（34）→ T.N（CyTech等の形式）
    if (age === null) {
      const bareAgeMatch = nameStripped.match(/[\s　]?[\(（](\d{2})[\)）]/)
      if (bareAgeMatch) {
        age = parseInt(bareAgeMatch[1], 10)
        nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[\)）]/, '').trim()
      }
    }
  }

  // ── 独立した「年齢：」「性別：」ラベルからのフォールバック ──────────
  // 名前欄に年齢・性別が併記されず、別フィールドとして分離している経歴書
  // （例: 「氏名：IH」「年齢：24歳」「性別：女」が別々のラベルにある形式）向け。
  // 上記の名前直後括弧パターンで取得できなかった場合のみ試みる。
  if (age === null) {
    const ageFieldRaw = extractFieldTwoPhase(
      ['年齢', '年令', '満年齢'],
      bodyText, attachText,
      v => /^\d{2,3}[\s　]*[歳才]?$/.test(v.trim()),
      10, 1,
    )
    if (ageFieldRaw) {
      const ageNum = parseInt(ageFieldRaw.replace(/[歳才\s　]/g, '').trim(), 10)
      if (!isNaN(ageNum) && ageNum >= 15 && ageNum <= 90) age = ageNum
    }
  }
  if (gender === null) {
    const genderFieldRaw = extractFieldTwoPhase(
      ['性別'],
      bodyText, attachText,
      v => /^(男性|女性|男|女)$/.test(v.trim()),
      6, 1,
    )
    if (genderFieldRaw) gender = genderFieldRaw.trim()
  }

  // ── 名前後ろのスキル経験年数 (#79) ──────────────────────────────
  // 「K.T（Java 5年 / Python 3年）」のように名前の後ろ括弧にスキル年数が含まれるケース
  // 括弧内に「スキル名 X年」が1つ以上あれば nameSkillYears に抽出して括弧を除去
  let nameSkillYears: Record<string, number> | null = null
  {
    const skillYearBracket = nameStripped.match(/[\(（]([^)）]{3,80})[\)）]$/)
    if (skillYearBracket) {
      // ` / ` や `・` `、` `,` で区切られた各エントリを個別にパース
      const parts = skillYearBracket[1].split(/\s*[\/／・、,]\s*/)
      const entries: Record<string, number> = {}
      for (const part of parts) {
        const m = part.trim().match(/^(.+?)[ 　]+(\d+(?:\.\d+)?)\s*年/)
        if (m) {
          const skillName = m[1].trim()
          const yrs = parseFloat(m[2])
          if (skillName && yrs > 0 && yrs <= 50) entries[skillName] = Math.round(yrs * 12)
        }
      }
      if (Object.keys(entries).length > 0) {
        nameSkillYears = entries
        nameStripped = nameStripped.replace(/[\s　]?[\(（][^)）]{3,80}[\)）]$/, '').trim()
      }
    }
  }

  // ── ラベルなし 名前+年齢+性別 フォールバック ─────────────────────
  // 「■C-TN（44歳 / 男性）」のようにラベルなしで氏名・年齢・性別が記載されている場合
  // name/age/gender のいずれかが未取得なら全文スキャンで補完する
  // 数字のみになった名前は不明扱い（例: 氏名：0004 → null）(#67)
  let name: string | null = (nameStripped && !/^\d+$/.test(nameStripped)) ? nameStripped : null
  let bracketStation: string | null = null
  if (!name || age === null || gender === null) {
    const allTextForName = bodyText + '\n' + attachText
    // 行頭デコレータ（任意）＋名前＋（年齢 / 性別）パターン — 年齢先
    const noLabelPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([^\d\s　（(\n【]{1,20})[ 　]?[（(](\d{2})[才歳][ 　]*[/／：: ][ 　]*(男性|女性|男|女)(?:[/／][^)）]*)?[）)]/m
    // 行頭デコレータ（任意）＋名前＋（性別 / 年齢）パターン — 性別先
    const noLabelPatGF = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([^\d\s　（(\n【]{1,20})[ 　]?[（(](男性|女性|男|女)[ 　]*[/／][ 　]*(\d{2})[才歳][）)]/m
    const nlM = allTextForName.match(noLabelPat)
    const nlMGF = !nlM ? allTextForName.match(noLabelPatGF) : null
    // 【YY、46歳、男性、馬橋駅、弊社正社員】 形式（全情報をカンマ区切りで1行に記載）
    const bracketPat = /【([^\d、,】]{1,15})、(\d{1,3})[才歳]、(男性|女性)、([^、】]{2,20}?)(?:、[^】]*)?】/
    const nlBracket = (!nlM && !nlMGF) ? allTextForName.match(bracketPat) : null
    if (nlM) {
      // [氏名]OY のような半角ブラケットラベル前置きを除去
      if (!name)           name   = (nlM[1].trim().replace(/^\[[^\]]{1,10}\]/, '') || null)
      if (age === null)    age    = parseInt(nlM[2], 10)
      if (gender === null) gender = nlM[3]
    } else if (nlMGF) {
      if (!name)           name   = (nlMGF[1].trim().replace(/^\[[^\]]{1,10}\]/, '') || null)
      if (gender === null) gender = nlMGF[2]
      if (age === null)    age    = parseInt(nlMGF[3], 10)
    } else if (nlBracket) {
      if (!name)           name   = nlBracket[1].trim() || null
      if (age === null)    age    = parseInt(nlBracket[2], 10)
      if (gender === null) gender = nlBracket[3]
      // 4番目の要素が駅名であれば nearestStation にも設定（後でoverrideされる可能性あり）
      if (nlBracket[4]?.includes('駅')) bracketStation = nlBracket[4].trim()
    }
    // ≪名前 (年齢歳) 性別≫ 形式（Dearism等の「≪≫」デリミタ形式）(#94)
    if (!name || age === null || gender === null) {
      const dearismPat = /≪([^≪≫（(\n]{1,20}?)[ 　]*[（(](\d{2})[才歳][）)][ 　]*(男性|女性|男|女)/
      const nlD = allTextForName.match(dearismPat)
      if (nlD) {
        if (!name)           name   = nlD[1].trim() || null
        if (age === null)    age    = parseInt(nlD[2], 10)
        if (gender === null) gender = nlD[3]
      }
    }
    // 「■MM（石川町）男性・57歳」形式（括弧内は駅名で年齢・性別ではなく、
    // 性別・年齢は括弧の外に「・」区切りで続く）
    if (!name || age === null || gender === null) {
      const stationParenPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Za-zＡ-Ｚａ-ｚ]{1,10})[　 ]?[（(][^)）\d]{1,15}[）)][　 ]*(男性|女性|男|女)[・･][　 ]*(\d{2})[才歳]/m
      const nlSP = allTextForName.match(stationParenPat)
      if (nlSP) {
        if (!name)           name   = nlSP[1].trim() || null
        if (gender === null) gender = nlSP[2]
        if (age === null)    age    = parseInt(nlSP[3], 10)
      }
    }
    // 括弧なし「名前　N歳性別」形式（例: "MK_S　48歳男"）— 区切り文字が空白のみで
    // 括弧・記号を一切伴わない場合。行頭の非空白トークンを名前候補として採用する
    if (age === null || gender === null) {
      const bareAgeGenderPat = /(?:^|\n)[ 　]*([^\d\s　\n]{1,20})[　 ]+(\d{2})[才歳][　 ]?(男性|女性|男|女)/m
      const nlBare = allTextForName.match(bareAgeGenderPat)
      if (nlBare && !NAME_FIELD_LABELS.test(nlBare[1].trim())) {
        if (!name)           name   = nlBare[1].trim() || null
        if (age === null)    age    = parseInt(nlBare[2], 10)
        if (gender === null) gender = nlBare[3]
      }
    }
  }

  // 国籍 — 名前括弧内: （中国籍）（外国籍）（日本）等を抽出・除去
  if (!nationality) {
    const natInName = nameStripped.match(/[\s　]?[\(（]([^)）\d]{1,15}[籍人国])[\)）]/)
    if (natInName) {
      nationality = natInName[1].trim()
      nameStripped = nameStripped.replace(/[\s　]?[\(（][^)）\d]{1,15}[籍人国][\)）]/, '').trim()
    }
  }
  // 国籍 — 名前外 ※XX籍 / ※外国籍 パターン（括弧なし）
  if (!nationality) {
    const allTextForNat = bodyText + '\n' + attachText
    const natMark = allTextForNat.match(/[※＊\*][ 　]?([^\s,、。（）「」【】\t]{1,15}[籍国人])/)
    if (natMark) nationality = natMark[1].trim()
  }
  // 国籍除去後のnameStrippedで上書き（フォールバックで取得済みなら維持）
  name = name || nameStripped || null
  // ※XX籍（在日N年）等が name に残っている場合は除去（#72）
  // 例: "A.E ※ナイジェリア籍（在日37年）" → "A.E"
  if (name) {
    name = name.replace(/[\s　]?[※＊\*][ 　]?[^\s,、。（）「」【】\t]{1,20}[籍国人](?:（[^）]*）)?/g, '').trim() || null
  }

  // ── 名前後処理: 残留汚染パターンを除去 ──────────────────────────
  // スラッシュ区切りで年齢が続くパターンを除去（例: "K.Y / 40歳 / 男性 / ベトナム籍" → "K.Y"）
  if (name) {
    const slashAgeM = name.match(/^([^/／]+?)[ 　]*[/／][ 　]*\d{1,2}[才歳]/)
    if (slashAgeM) {
      const beforeSlash = slashAgeM[1].trim()
      // スラッシュ前が1文字以上かつ数字のみでなければ名前として採用
      if (beforeSlash.length >= 1 && !/^\d+$/.test(beforeSlash)) {
        name = beforeSlash
      }
    }
  }
  // スラッシュ区切りの性別・国籍残留 (例: "O.A / 男性 / 日本）" → "O.A")
  if (name) {
    const trailGenderM = name.match(/[ 　]*[/／][ 　]*(男性|女性|男|女)[ 　]*(?:[/／][^）)]*)?[）)]?\s*$/)
    if (trailGenderM) {
      if (gender === null) gender = trailGenderM[1]
      name = name.replace(/[ 　]*[/／][ 　]*(男性|女性|男|女)[ 　]*(?:[/／][^）)]*)?[）)]?\s*$/, '').trim() || null
    }
  }
  // 末尾に国籍がベタ書きされているパターンを除去（例: "K.Y バングラデシュ籍" → "K.Y", nationality設定）
  if (name) {
    const natSuffix = name.match(/[ 　]([^\s　\d]{2,15}[籍])$/)
    if (natSuffix) {
      if (!nationality) nationality = natSuffix[1]
      name = name.replace(/[ 　][^\s　\d]{2,15}[籍]$/, '').trim() || null
    }
  }
  // 末尾に性別+閉じ括弧が残留 (例: "R・K　男性）" → "R・K")
  if (name) name = name.replace(/[ 　]*(男性|女性|男|女)[）)]\s*$/, '').trim() || null
  // 末尾にスペース+年齢が残留 (例: "MO 35歳", "AA　39歳")
  if (name && !age) {
    const trailingAgeM = name.match(/[ 　]+(\d{2})[才歳]$/)
    if (trailingAgeM) {
      age = parseInt(trailingAgeM[1], 10)
      name = name.replace(/[ 　]+\d{2}[才歳]$/, '').trim() || null
      if (name) name = name.replace(/[ 　]*[/／、，・][ 　]*$/, '').trim() || null
    }
  }
  // 末尾に括弧内2桁数字のみ = 年齢として取得 (例: "D.S（38）" → "D.S", age=38)
  if (name && !age) {
    const ageOnlyM = name.match(/[ 　]?[（(](\d{2})[）)]$/)
    if (ageOnlyM) {
      age = parseInt(ageOnlyM[1], 10)
      name = name.replace(/[ 　]?[（(]\d{2}[）)]$/, '').trim() || null
    }
  }
  // 名前中に【駅名】等の別フィールドが混入 (例: "【T・N】【豊岡】（男性..." → "T・N")
  if (name && name.includes('】【')) {
    // lookbehind で最初の 】 を残してそれ以降の【...】を除去（例:「【T・N】【豊岡】」→「T・N」）
    name = name.replace(/(?<=】)【.*$/, '').trim() || null
    if (name) name = name.replace(/^【([^】]+)】$/, '$1').trim() || null
  }

  // ── 最終安全網: 残留する年齢・性別を名前から除去 ─────────────────
  // 既存ロジックで捕捉しきれなかったパターンへの対策
  // ① カンマ・読点・スラッシュ区切りの年齢を除去 "W000085、57歳 男性..." → "W000085" / "MS/31歳/" → "MS"
  if (name) {
    const commaAgeM = name.match(/[、,/／]\s*(\d+)[才歳][\s\u3000]?(女性|男性|女|男)?/)
    if (commaAgeM) {
      if (age === null) age = parseInt(commaAgeM[1], 10)
      if (gender === null && commaAgeM[2]) gender = commaAgeM[2]
      name = name.replace(/[、,/／]\s*\d+[才歳].*$/, '').trim() || null
    }
  }
  // ② 年齢（2〜3桁+才/歳）が名前に含まれる場合はそこで切り捨て（直後の性別も同時に取得）
  // "YY　49才女性　日本籍..." → "YY" age=49 gender=女性 / "劉　KU　33歳　女性..." → "劉　KU" age=33
  if (name) {
    const ageInNameM = name.match(/^(.*?[^\d\s\u3000])[\s\u3000]?(\d{2,3})[才歳][\s\u3000]?(女性|男性|女|男)?/)
    if (ageInNameM && ageInNameM[1].trim().length >= 1) {
      if (age === null) age = parseInt(ageInNameM[2], 10)
      if (gender === null && ageInNameM[3]) gender = ageInNameM[3]
      name = ageInNameM[1].trim() || null
    }
  }
  // ③ 性別（男性/女性/男/女）が名前に含まれる場合はそこで切り捨て（スペースなし・後続テキスト付きでも対応）
  // "K.Y男性　香港籍" → "K.Y" / "K・M　男性" → "K・M" / "MOSN 男" → "MOSN"
  if (name) {
    const genderInNameM = name.match(/^(.+?)[\s\u3000]?(男性|女性|男|女).*$/)
    if (genderInNameM && genderInNameM[1].trim().length >= 1) {
      if (gender === null) gender = genderInNameM[2]
      name = genderInNameM[1].trim() || null
    }
  }
  // ④ 名前末尾の孤立した括弧・区切り記号を除去（例:「国PF（」→「国PF」）
  if (name) name = name.replace(/[（(【,、\/／・\s　]+$/, '').trim() || null
  // ⑤ 名前内に残留する括弧内コメントを除去（例: K.K（録音音声ございます！）→ K.K）(#89)
  // 年齢・性別・国籍・スキル年数は上位ステップで処理済みのため、残留括弧は全て不要情報
  if (name) {
    const firstBracket = name.search(/[（(]/)
    if (firstBracket > 0) {
      name = name.substring(0, firstBracket).trim() || null
    }
  }
  // ⑥ ☆フィールド区切り形式の残留を除去（例: "IA ☆最　寄：大村駅" → "IA"）
  // 「☆名　前：IA ☆最　寄：駅名 ☆稼　働：...」のように全フィールドが1行に並ぶ書式対応
  if (name) name = name.replace(/[ 　]*☆.*$/, '').trim() || null

  // ── イニシャルのみパターン フォールバック ─────────────────────
  // 「A.M」「K・S」「K.S（45歳/男性）」のようにラベルなしでイニシャルが記載されている場合
  // カンマ区切り「M,T」も拾い、ドット区切り「M.T」に正規化する
  // 既に名前が取れている場合はスキップ
  if (!name) {
    const allTextForInitials = bodyText + '\n' + attachText
    // パターン1: イニシャル + 年齢/性別 (例: K.S（45歳/男性）/ M,T（23）男性)
    const initialsPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Z][.．・,][A-Z])[ 　]?[（(](\d{2})[才歳][^)）]*[）)]/m
    // パターン2: イニシャルのみ（行頭 + 任意デコレータ。例: G.S / ■G.S）
    const initialsOnlyPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Z][.．・,][A-Z])(?:[ 　]|$)/m
    const imatch = allTextForInitials.match(initialsPat)
    const imatchOnly = !imatch ? allTextForInitials.match(initialsOnlyPat) : null
    if (imatch) {
      name = imatch[1].trim().replace(',', '.')
      if (age === null) age = parseInt(imatch[2], 10)
    } else if (imatchOnly) {
      name = imatchOnly[1].trim().replace(',', '.')
    }
  }

  // ── ラベルあり別行フォールバック（年齢：30歳 / 性別：女性 / 国籍：中国）─
  // 名前から取れなかった場合に本文ラベルから補完する
  if (age === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/年\s*[　 ]*齢[\s　 ]*[：:]\s*(\d{2})[才歳]/)
    if (m) age = parseInt(m[1], 10)
  }
  // Excel CSV 形式フォールバック: 「年齢 / 34」（cleanseExcelCsv が / 区切りに変換する形式）
  if (age === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/年\s*[　 ]*齢[\s　 ]*[/／]\s*(\d{2,3})(?!\s*[年ヶ月])/)
    if (m) { const v = parseInt(m[1], 10); if (v >= 18 && v <= 80) age = v }
  }
  if (gender === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/性\s*[　 ]*別[\s　 ]*[：:]\s*(男性|女性|男|女)/)
    if (m) gender = m[1]
  }
  // Excel CSV 形式フォールバック: 「性別 / 男」
  if (gender === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/性\s*[　 ]*別[\s　 ]*[/／]\s*(男性|女性|男|女)/)
    if (m) gender = m[1]
  }
  if (!nationality) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/国\s*[　 ]*籍[\s　 ]*[：:]\s*([^\s\n、。]{1,15})/)
    if (m) nationality = m[1].trim()
  }
  // 国籍 — ラベル・括弧・マーカーなしのベタ書き（例: "K.Y男性　香港籍" "中国籍" "外国籍"）
  // 区切り（空白/スラッシュ/読点/括弧/行頭）の直後の「XX籍」を拾う。
  // 在籍・本籍・戸籍・書籍など一般語、および日本人前提の "日本籍" は誤検出を避けるため除外しない（情報として有用）
  if (!nationality) {
    const allTextForNatInline = bodyText + '\n' + attachText
    const natInline = allTextForNatInline.match(/(?:^|[\s　/／・,、|｜（(])((?:[ァ-ヶー]{2,8}|[一-龠]{2,6})籍)/m)
    // 「在籍」を含む語（大学在籍・現在在籍等）も除外する
    const EXCLUDE_NAT = /^(在籍|本籍|戸籍|書籍|移籍|国籍|原籍|入籍|除籍|学籍|党籍|軍籍|転籍|復籍|船籍)$|在籍$/
    if (natInline && !EXCLUDE_NAT.test(natInline[1])) {
      nationality = natInline[1].trim()
    }
  }

  // ── 最寄駅 ────────────────────────────────────────────────────
  // 「渋谷」「大阪」など2文字の駅名もあるので phase3MinLen=2
  let nearestStation = extractFieldTwoPhase(
    ['最寄り?駅','最寄駅','最寄り?','沿線','通勤駅'],
    bodyText, attachText,
    v => {
      const c = v.replace(/（[^）]*）.*$/, '').trim()
      // セクション見出しと判定されるラベルは駅名として拒否（#58）
      if (/^(自己PR|PR|アピール|強み|備考|補足|資格|スキル|経験|氏名|年齢|性別|国籍|連絡先|住所|現住所|職歴|学歴|希望|稼働|単価|単金|ご担当|担当者|得意)/.test(c)) return false
      return /[駅線]$/.test(c) || (c.length <= 10 && /[^\x00-\x7F]/.test(c))
    },
    30,
    2,
  )
  // 【YY、46歳、男性、馬橋駅、...】形式から取得した駅名をフォールバックとして適用
  if (!nearestStation && bracketStation) nearestStation = bracketStation
  // ラベルなしフォールバック: 「○○駅徒歩N分」や「○○駅 」「○○駅.xlsx」（ファイル名含む）
  if (!nearestStation) {
    const allText = bodyText + '\n' + attachText
    // 駅名に含まれないセパレータ（_(アンダーバー)・()半角括弧）を除外してファイル名ベースの誤マッチを防ぐ
    const m = allText.match(/([^\s,、。（）()「」【】\t_]{1,10}駅)(?:[\s　_\-）」】()徒歩.)]|$)/)
    if (m) nearestStation = m[1].trim()
  }
  // 後処理: ラベル自体が値になっているケースを除外
  // 例: 「最寄駅」「イニシャル+最寄駅」「最寄：北13条東駅」→ 実駅名のみに修正
  if (nearestStation) {
    // 路線名カッコを除去（全角/半角どちらも対応）。
    // カッコ内が路線名（「線」で終わる）なら、捨てずに先頭へ移す:
    // DB照合時に路線名から同名駅（例:桜台=東京/福岡）を判別できるようにするため。
    // 例: 「桜台(西武池袋線)」→「西武池袋線桜台」/「綾瀬駅（東京メトロ千代田線 / JR常磐線）」→「JR常磐線綾瀬駅」
    const parenLineMatch = nearestStation.match(/^([^\s（(]+)[（(]([^）)]*線)(?:[／/][^）)]*)?[）)].*$/)
    if (parenLineMatch) {
      nearestStation = parenLineMatch[2] + parenLineMatch[1]
    } else {
      nearestStation = nearestStation.replace(/[（(][^）)]*[）)].*$/, '').trim()
    }
    // 「線『駅名』」形式（例:「JR総武線「市川」」「山手線「浜松町」」）: カギ括弧内を駅名候補として取り出す
    const kagiMatch = nearestStation.match(/線[「『]([^」』]{1,10})[」』]/)
    if (kagiMatch) nearestStation = kagiMatch[1]
    // 路線名スラッシュ・中点区切りを除去: 「JR京浜東北線／蕨駅」「西武池袋線・東長崎駅」→「蕨駅」「東長崎駅」
    nearestStation = nearestStation.replace(/^.+[/／・]/, '').trim()
    // 「最寄：北13条東駅」のようにコロン区切りで前半がラベルの場合、後半だけ取る
    const colonMatch = nearestStation.match(/[：:](.+駅.*)$/)
    if (colonMatch) nearestStation = colonMatch[1].trim()
    // 「線」を持たない公営地下鉄・新交通等の事業者名プレフィックスを剥がす
    // 例:「横浜市営地下鉄岸根公園」→「岸根公園」「埼玉新都市交通伊奈中央」→「伊奈中央」
    // ただし「地下鉄成増」「地下鉄赤塚」「モノレール浜松町」等、事業者名で始まる正式駅名は
    // 剥がすと別駅名になるため除外する（先頭一致の実駅名を保護）。
    if (!/^(地下鉄成増|地下鉄赤塚|モノレール[^\s　]|ゆりかもめ[^\s　])/.test(nearestStation)) {
      nearestStation = nearestStation.replace(/^.*?(市営地下鉄|地下鉄|新都市交通|モノレール|ゆりかもめ)/, '')
    }
    // ラベルそのものや template text・セクション見出しは除外
    if (/^(最寄り?駅?|沿線|通勤駅|イニシャル|代表者|最寄り?$)/.test(nearestStation)
      || nearestStation.includes('イニシャル')
      || nearestStation.includes('最寄駅')
      || /^(自己PR|PR|アピールポイント|強み|備考|補足|資格|スキル|経験|希望|現住所|住所|氏名|年齢|性別|国籍|連絡先|所属|担当|役職)$/.test(nearestStation)
      // 明らかな非駅名ノイズ（誤抽出）を拒否。文中のどこにあっても対象（先頭一致に限定しない）
      || /(■|IT経験|経験年数|フルリモート|引っ越し|引越し|転居|首都圏|シリコンバレー)/.test(nearestStation)) {
      nearestStation = null
    }
    // 「西武池袋線　飯能駅」→「飯能駅」（路線名+スペース+駅名 → 駅名だけ取る）
    // 「汐入駅常駐可」→「汐入駅」（駅名以降の余分な語句を除去）
    if (nearestStation) {
      const stationOnly = nearestStation.match(/([^\s　]{2,12}駅)$/)
      if (stationOnly && stationOnly[1] !== nearestStation) {
        nearestStation = stationOnly[1]
      } else if (!nearestStation.endsWith('駅')) {
        // 末尾が駅でない場合: 先頭の駅名部分だけ取る
        const stationStart = nearestStation.match(/^([^\s　]{1,12}駅)/)
        if (stationStart) nearestStation = stationStart[1]
      }
    }
    // 末尾の付帯情報を除去（駅サフィックスの有無に関わらず。「都内」等の勤務地修飾も含めて剥がす）
    // 例:「二子玉川※常駐可能」→「二子玉川」「幸手※都内出勤可」→「幸手」
    if (nearestStation) {
      nearestStation = nearestStation.replace(/[※]?(都内|都内へ)?(常駐可能?|出勤可能?|リモート可能?|通勤可能?)$/, '').trim() || null
    }
  }

  // ── 都道府県 ──────────────────────────────────────────────────
  // ラベル付き抽出を優先し、なければ全文から都道府県リストを検索
  let prefecture = extractFieldTwoPhase(
    ['住所','居住地','在住','現住所','都道府県','居住エリア','在住地'],
    bodyText, attachText,
    v => PREFECTURES.some(p => v.includes(p)),
    40,
  )
  if (prefecture) {
    // 「大阪府大阪市〜」から都道府県部分だけ取り出す
    const found = PREFECTURES.find(p => prefecture!.includes(p))
    if (found) prefecture = found
  }
  if (!prefecture) {
    // 全文走査時に送信者署名（〒XXX-XXXX 東京都...）を除外して誤判定を防ぐ。
    // 同様に署名内の "■MAIL/TEL/FAX/URL" 行も除外する。
    const allText = stripSenderSignature(bodyText) + '\n' + attachText
    // PREFECTURES配列順ではなくテキスト内出現順で最初に登場する都道府県を採用する。
    // （配列順だと '東京都' が '大阪府' より前にあるため、大阪在住の候補者が東京と誤判定される問題を防ぐ）
    let firstIdx = Infinity
    let firstPref: string | null = null
    for (const p of PREFECTURES) {
      const idx = allText.indexOf(p)
      if (idx !== -1 && idx < firstIdx) {
        firstIdx = idx
        firstPref = p
      }
    }
    prefecture = firstPref
  }
  // 最寄駅から推定できる都道府県があれば最優先で採用する。
  // 送信者署名（東京都町田市等）由来の誤判定を上書きするため、
  // station 推定が一致した場合のみ駅由来を使う。
  const stationPrefecture = inferPrefectureFromStation(nearestStation)
  if (stationPrefecture) {
    if (!prefecture || prefecture !== stationPrefecture) {
      prefecture = stationPrefecture
    }
  }

  // ── 経験年数 ──────────────────────────────────────────────────
  let experienceYears: number | null = null
  // 全角数字→半角数字に正規化してからマッチ
  const normalizeDigits = (s: string) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))
  // dedicated: 「経験年数：」等の専用ラベルからの明示的な自己申告値。候補者本人の意図的な
  //   申告なので、Excel添付の日付スパン推定（前職期間等も含みがちで過大評価しやすい）で
  //   安易に上書きしてはいけない。
  // !dedicated（汎用）: 「〇〇経験\nN年」のような自由文中の役割別内訳等に誤マッチしうるため、
  //   Excel実データの方が大きければそちらを優先してよい。
  const expPatterns: Array<{ re: RegExp; dedicated: boolean }> = [
    // 「エンジニア歴：10年」「SE歴：8年」「技術歴7年」など 職種/技術 + 歴 形式（セパレータ任意）
    { re: /(?:IT|エンジニア|SE|PG|開発|プログラム|システム|設計|インフラ|クラウド|技術|現場)(?:開発)?歴[：:\s　]*[約]?\s*(\d+)\s*年/, dedicated: true },
    // セパレータ必須にして「業務経験1年以上」等の凡例テキストへの誤マッチを防ぐ
    // 「【経験】：3年9カ月」のようにラベルが【】で囲まれ、閉じ括弧がセパレータの前に来る
    // 形式にも対応するため「】」を許容する
    { re: /経験[】]?[：:\s　]+[約]?\s*(\d+)\s*年/, dedicated: false },
    { re: /(\d+)\s*年[以上間程度]*(?:の)?(?:経験|実務|開発|IT|エンジニア)/, dedicated: false },
    // 「経験\r\n年数」のようにラベル自体が改行で分断されるケースがあるため、
    // 「経験」と「年数」の間に任意の空白（改行含む）を許容する
    { re: /(?:経験[\s　]*年数|開発経験|実務経験)[】]?[：:\s]*[約]?\s*(\d+)年/, dedicated: true },
    // 自然文中の「経験年数は約2年と若手ですが」のように助詞（は/が/も）を挟む言い回し
    { re: /経験[\s　]*年数[はがも]\s*[約]?\s*(\d+)\s*年/, dedicated: true },
    { re: /(?:社会人歴|就労歴|通算|合計|累計|キャリア)[：:\s　]*[約]?\s*(\d+)\s*年/, dedicated: true },
  ]
  let experienceYearsIsDedicated = false
  const allText = normalizeDigits(bodyText + '\n' + attachText)
  for (const { re: p, dedicated } of expPatterns) {
    // 同一パターンで複数箇所にマッチすることがある（例:「プログラマー経験\n2年7か月」
    // 「プランナー経験\n10年1ヶ月」のような役割別内訳の並記）。最初に見つかった箇所が
    // 必ずしも本来の主経験年数とは限らないため、そのパターン内での最大値を採用する。
    const globalP = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`)
    let maxY: number | null = null
    let m: RegExpExecArray | null
    while ((m = globalP.exec(allText)) !== null) {
      const y = parseInt(m[1], 10)
      // 4桁は西暦年（2020年等）の誤マッチの可能性が高いため除外
      if (y > 0 && y <= 50 && String(y).length < 4 && (maxY === null || y > maxY)) {
        maxY = y
      }
    }
    if (maxY !== null) { experienceYears = maxY; experienceYearsIsDedicated = dedicated; break }
  }
  // フォールバック: 「経験年数」を明言せず「・項目：期間」の箇条書き内訳のみのケース
  // （例: ・ヘルプデスク：10ヶ月 / ・テスト実施：5ヶ月）→ 合算して概算の経験年数とする
  // 2件以上の箇条書きがある場合のみ採用（1件だけだと単一案件の期間と区別できないため）
  if (experienceYears === null) {
    const bulletDurationRE = /^[・\-]\s*[^：:\n]{1,40}[：:]\s*((?:\d+\s*年)?\s*(?:\d+\s*[ヶかカヵｶ]月)?)\s*$/gm
    let totalMonths = 0
    let bulletCount = 0
    let bm: RegExpExecArray | null
    while ((bm = bulletDurationRE.exec(allText)) !== null) {
      const months = parseDurationToMonths(bm[1])
      if (months) { totalMonths += months; bulletCount++ }
    }
    if (bulletCount >= 2 && totalMonths > 0) {
      const y = Math.round(totalMonths / 12)
      if (y > 0 && y <= 50) experienceYears = y
    }
  }

  // ── 希望単価 ──────────────────────────────────────────────────
  let desiredRate: string | null = extractFieldTwoPhase(
    ['希望単価','目安単価','単価','単金','単　金','単 金','希望報酬','希望月額','月額','月単価','希望料金'],
    bodyText, attachText,
    v => /\d/.test(v),
    20,
  )
  if (!desiredRate) {
    // ① ラベル付き（単価: 65万 / 単価65万〜70万 / 単価60〜65万円 等）
    const rateM1 = allText.match(
      /(?:希望[単]?価|単価|月額|月単価)[：:\s　]*(\d{2,3}[〜~－\-]?\d{0,3})\s*万\s*円?(?:[以上\/月程度台〜~]|$|\D)/
    )
    // ② 範囲（終端に万）: 60〜65万円
    const rateM2 = !rateM1 ? allText.match(
      /(\d{2,3})\s*[〜~]\s*(\d{2,3})\s*万\s*円?/
    ) : null
    // ③ 単独値: XX万円以上 / XX万/月 / XX万程度
    const rateM3 = (!rateM1 && !rateM2) ? allText.match(
      /(\d{2,3})\s*万\s*円?(?:以上|\/月|程度|台)/
    ) : null

    if (rateM1) {
      const raw = rateM1[1]
      const hasRange = /[〜~－\-]/.test(raw) && /\d{2,3}$/.test(raw)
      desiredRate = hasRange ? `${raw}万円` : `${raw}万円`
    } else if (rateM2) {
      const lo = parseInt(rateM2[1], 10), hi = parseInt(rateM2[2], 10)
      if (lo >= 20 && hi <= 300) desiredRate = `${lo}〜${hi}万円`
    } else if (rateM3) {
      const amount = parseInt(rateM3[1], 10)
      if (amount >= 20 && amount <= 300) {
        const raw = rateM3[0]
        const suffix = raw.includes('以上') ? '万円以上' : raw.includes('/月') ? '万円/月' : '万円'
        desiredRate = `${amount}${suffix}`
      }
    }
  }

  // ── 稼働可能時期 ──────────────────────────────────────────────
  // スペースを含む「稼 働」などもマッチさせるため、正規化テキストも用意
  const normalizedAllText = allText.replace(/稼\s+働/g, '稼働').replace(/参\s+画/g, '参画')
  let availableFrom = extractFieldTwoPhase(
    ['参画開始可能日','参画可能時期','参画可能','稼働開始月','稼働開始','稼働可能時期','稼働可能','稼働時期','開始可能日','稼動時期','稼働','参画時期','参画開始','就業開始','就業時期','就業可能時期'],
    normalizedAllText, attachText,
    v => v.length >= 2,
    30,
  )
  // 即日検出（【稼働】即日 / 稼働：即日 など）
  if (!availableFrom && /(?:^|[\s　【:：])即日(?:[\s　】]|$)/.test(normalizedAllText)) availableFrom = '即日'
  // 「6月〜」「7月上旬」「2026/6」「2026年6月」形式
  if (!availableFrom) {
    const dateM = normalizedAllText.match(/(?:稼働|参画|就業)[^。\n]{0,10}?([0-9０-９]{1,4}[\/年\-][0-9０-９]{1,2}(?:[\/月\-][0-9０-９]{1,2}日?)?)/i)
      ?? normalizedAllText.match(/(?:稼働|参画)[^。\n]{0,5}?([0-9]{1,2}月(?:上旬|中旬|下旬|初旬)?(?:[〜~])?)/i)
    if (dateM) availableFrom = dateM[1].trim()
  }

  // ── 希望案件 ──────────────────────────────────────────────────
  const desiredProject = extractFieldTwoPhase(
    ['希望案件','希望職種','希望業界','希望条件','希望業務','ご希望案件','ご希望','希望'],
    bodyText, attachText,
    v => v.length >= 2,
    50,
  )

  // ── 送信元会社名（from_company） ──────────────────────────────
  // メール署名エリア（末尾2000文字）から会社名を抽出。
  // 宛先側の会社名（〇〇御中・〇〇様）は除外。
  // 署名は常に本文（bodyText）側にあり添付ファイル（候補者の経歴書等）には通常含まれない。
  // allBodyText（本文+添付テキスト）の末尾から取ると、添付が長い場合（Excelの職務経歴が
  // 数千文字に及ぶ等）に本文末尾の署名が範囲外に押し出されてしまい、会社名抽出が丸ごと
  // 失敗して件名の壊れたブラケット等に誤ってフォールバックする事故になるため、
  // bodyText 単独から取得する。
  let fromCompany: string | null = null
  const allBodyText = bodyText + '\n' + attachText
  const sigArea = bodyText.slice(-2000)

  // 宛先行チェック: マッチ位置の直後に「様」「御中」「ご担当」が続く場合は宛先として除外
  function isSalutation(text: string, matchIndex: number, matchLen: number): boolean {
    const after = text.slice(matchIndex + matchLen, matchIndex + matchLen + 40)
    return /^[\r\n　 ]*(?:様|御中|ご担当|担当者様|採用担当|ご関係者)/.test(after)
  }

  // 全マッチを収集して宛先以外の最後のマッチを採用（送信者署名は末尾に近いため）
  const PRE_RE = /(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[　 ]?([^\s　の\n（(、。！【】「」]{2,30}(?:[ \t]+(?!https?:)[A-Za-z][A-Za-z \t&.]{0,20})?)/g
  let bestPre: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = PRE_RE.exec(sigArea)) !== null) {
    if (!isSalutation(sigArea, m.index, m[0].length)) bestPre = m
  }
  if (bestPre) fromCompany = sanitizeFromCompany(`${bestPre[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]}${bestPre[1]}`)

  // 「XXX株式会社」末尾パターン（前述で取れなかった場合・半角・全角スペース対応）
  if (!fromCompany) {
    const POST_RE = /([^（(（\s　\n、。！【】「」]{2,20})[　 ]?(?:株式会社|有限会社|合同会社)/g
    let bestPost: RegExpExecArray | null = null
    while ((m = POST_RE.exec(sigArea)) !== null) {
      if (!isSalutation(sigArea, m.index, m[0].length)) bestPost = m
    }
    if (bestPost) fromCompany = sanitizeFromCompany(`${bestPost[1]}${bestPost[0].match(/株式会社|有限会社|合同会社/)?.[0]}`)
  }

  // ③ 本文冒頭の「XXXのXX担当です」パターン（法人格なしのカタカナ社名: フォスターネット等）
  if (!fromCompany) {
    const introArea = allBodyText.slice(0, 600)
    const introM = introArea.match(/\n([ァ-ヶーA-Za-z0-9&（）()．.]{2,20})の(?:[^\s　\n]{0,10})?(?:担当|営業|事業|部長|代表|スタッフ|コンサルタント|パートナー|アライアンス)/)
    if (introM) {
      const cand = introM[1].trim()
      if (cand.length >= 2 && !/弊社|御社|各社|自社|貴社/.test(cand)) {
        fromCompany = cand
      }
    }
  }

  // ④ 件名の【会社名】パターン（例: 「のご紹介【フォスターネット】」「【サクヤ 保母】」）
  // 会社名は件名の末尾ブラケットにあることが多い → 末尾（最後）の【...】を優先試行、
  // ダメなら先頭へフォールバックする
  if (!fromCompany) {
    const subjectLine = allBodyText.split('\n')[0]
    // スキル・職種・条件キーワードを含むブラケットは除外
    const BRACKET_NON_COMPANY = /グループ|正社員|プロパ|常駐|可能|フリー|派遣|紹介|エンジニア|人材|要員|スキル|案件|開発|設計|即日|リモート|テレワーク|在宅|経験|言語|Java|Python|PHP|Go|AWS|Azure|GCP|SQL|Vue|React|Angular|Spring|Kotlin|Swift|TypeScript|Ruby|COBOL|C\+\+|C#|Docker|Linux|Windows|月.*[〜~～]|[〜~～].*月|[0-9]+年/
    // まず最後の【...】を試みる
    const allBrackets = [...subjectLine.matchAll(/【([^】]{2,25})】/g)]
    let bracketCand: string | null = null
    // 後ろから順に適切な会社名候補を探す
    for (let i = allBrackets.length - 1; i >= 0; i--) {
      const inner = allBrackets[i][1].trim()
      const companyPart = inner.split(/[\s　]/)[0] // スペース前が会社名（「サクヤ 保母」→「サクヤ」）
      if (companyPart.length >= 2 && !BRACKET_NON_COMPANY.test(inner)) {
        bracketCand = companyPart
        break
      }
    }
    // スペースなしで「会社名+担当者姓」が結合しているケース（例:「サクヤ新山」＝会社名
    // 「サクヤ」+ 担当者姓「新山」）に対応する。本文署名に担当者の氏名が「姓　名」形式
    // （新山　あみ 等）で実在し、その姓が bracketCand の末尾と一致する場合は姓部分を除去する。
    if (bracketCand) {
      const staffNameMatch = sigArea.match(/(?:^|\n)[　 ]*([一-龯ぁ-んァ-ヶ]{1,4})[　 ]+[ぁ-んァ-ヶA-Za-z]/)
      if (staffNameMatch) {
        const staffSurname = staffNameMatch[1]
        if (staffSurname.length < bracketCand.length && bracketCand.endsWith(staffSurname)) {
          bracketCand = bracketCand.slice(0, -staffSurname.length)
        }
      }
    }
    if (bracketCand) fromCompany = bracketCand
  }

  return { name, age, gender, nationality, nearestStation, prefecture, experienceYears, experienceYearsIsDedicated, desiredRate, availableFrom, desiredProject, fromCompany, nameSkillYears }
}

/**
 * 文章スキャンフェーズ（ProseExtract）
 *
 * ラベル-値ペアでは取れない roles / industries / workStyle を対象に、
 * 「文章的な行」（20文字超 or 読点・句点を含む）からキーワードリストで抽出する。
 * AI が空で返した場合のフォールバックとして呼び出す。
 */

const PROSE_ROLES: Array<{ re: RegExp; label: string }> = [
  { re: /(?<![A-Z])PMO(?![A-Z])|プロジェクト[　 ]?マネジメント[　 ]?オフィス/, label: 'PMO' },
  { re: /(?<![A-Z])PM(?!O)(?![A-Z])|プロジェクト[　 ]?マネージャー/, label: 'プロジェクトマネージャー' },
  { re: /(?<![A-Z])PL(?![A-Z])|プロジェクト[　 ]?リーダー/,       label: 'プロジェクトリーダー' },
  { re: /(?<![A-Z])TL(?![A-Z])|テックリード|テック[　 ]?リード/,   label: 'テックリード' },
  { re: /(?<![バックエンドフロントクラウドデータML])SE(?![A-Z])|システム[　 ]?エンジニア(?!長)/, label: 'システムエンジニア' },
  { re: /PG|プログラマー?/,                            label: 'プログラマー' },
  { re: /インフラ[　 ]?エンジニア/,                    label: 'インフラエンジニア' },
  { re: /フロントエンド[　 ]?エンジニア|フロント[　 ]?エンジニア/, label: 'フロントエンドエンジニア' },
  { re: /バックエンド[　 ]?エンジニア|バック[　 ]?エンジニア/,    label: 'バックエンドエンジニア' },
  { re: /フルスタック[　 ]?エンジニア/,                label: 'フルスタックエンジニア' },
  { re: /クラウド[　 ]?エンジニア/,                    label: 'クラウドエンジニア' },
  { re: /データ[　 ]?エンジニア/,                      label: 'データエンジニア' },
  { re: /MLエンジニア|機械学習[　 ]?エンジニア/,       label: 'MLエンジニア' },
  { re: /スクラム[　 ]?マスター/,                      label: 'スクラムマスター' },
  { re: /アーキテクト/,                                label: 'アーキテクト' },
  { re: /コンサルタント/,                              label: 'コンサルタント' },
  { re: /テスト[　 ]?(?:リード|エンジニア|設計)/,      label: 'テストエンジニア' },
  { re: /運用[　 ]?(?:保守|管理)/,                     label: '運用保守' },
]

// 業界判定の false positive を避けるため、複合語や明示語のみマッチさせる。
// 例:
//   - "製造" 単独 → スキルシートのフェーズ名「製造/構築」に誤マッチするため "製造業" 等を要求
//   - "教育" 単独 → 「新人教育」「ITパスポート研修」のような社内研修にも誤マッチするため
//                   「教育機関」「学校法人」「EdTech」等の業界明示語のみマッチ
//   - "学習" 単独 → 「機械学習」「自己学習」等にも誤マッチするため削除
const PROSE_INDUSTRIES: Array<{ re: RegExp; label: string }> = [
  { re: /金融機関|銀行|証券|保険会社|生命?保険|損害?保険|信用金庫|信託銀行|FinTech|フィンテック|金融業界|金融系/, label: '金融' },
  { re: /医療機関|ヘルスケア|病院|クリニック|製薬|医薬品|MedTech|医療業界/, label: '医療・ヘルスケア' },
  { re: /製造業|メーカー(?!ロゴ)|プラント|工場(?!勤務|常駐|地域|長)|IoT分野|FAシステム|自動車業界|電気業界|電機メーカー|製造業界/, label: '製造' },
  { re: /(?:^|[^A-Z])EC(?![A-Z])|イーコマース|eコマース|電子商取引|物流(?!倉庫担当)|運送業|商社/, label: 'EC・物流' },
  { re: /小売(?:業)?|流通(?:業)?|リテール|百貨店|スーパー|コンビニ/, label: '小売・流通' },
  { re: /通信(?:業|会社|キャリア|機器)?|テレコム|キャリア(?![,\sア-ン])/, label: '通信' },
  { re: /ゲーム業界|エンタメ|エンターテインメント|メディア業界|動画配信|配信プラットフォーム/, label: 'ゲーム・エンタメ' },
  { re: /不動産|建設|住宅|プロパティ|デベロッパー/, label: '不動産・建設' },
  { re: /官公庁|自治体|公共(?!IT)|行政|省庁|外務省|区役所|市役所|県庁|地方公共団体/, label: '公共・官公庁' },
  { re: /教育機関|学校法人|塾|EdTech|eLearning|教育業界|学校教育|大学|高校|専門学校/, label: '教育' },
  { re: /SES(?![A-Z])|受託(?:開発)?|SI(?!P|[A-Z])|システムインテグレーション/, label: 'SES・SI' },
  { re: /スタートアップ|ベンチャー(?:企業)?/, label: 'スタートアップ' },
  { re: /人材(?:業界|業)|HR(?![A-Z]|テスト)|HRTech|採用(?:業務|プラットフォーム|マーケット)/, label: '人材・HR' },
  { re: /マーケ(?:ティング)?(?:業界|職)?|広告(?:代理店|業界)?|デジタルマーケ/, label: 'マーケティング' },
]

const PROSE_WORKSTYLE: Array<{ re: RegExp; label: string }> = [
  { re: /フルリモート|完全リモート|100%リモート/,      label: 'フルリモート' },
  { re: /週[234]日.*リモート|リモート.*週[234]日/,     label: 'リモート可' },
  { re: /リモート[　 ]?[可能OK]/,                      label: 'リモート可' },
  { re: /常駐[　 ]?(?:不可|なし)|在宅[　 ]?希望/,     label: 'リモート希望' },
  { re: /常駐[　 ]?(?:可|OK|あり)|フル常駐/,          label: '常駐可' },
]

/**
 * 本文からワークスタイル（リモート/常駐/出社）の記載文をそのまま抽出する。
 * 「フルリモート（梅田／神戸は常駐可能）、東京は初日・緊急時出社可」のような拠点別・条件付きの
 * ニュアンスは分類では潰れるため、生の条件文を残して人が判断できるようにする（設計書:
 * docs/employment_commercialflow_design.md 同様の思想。ワークスタイルは自由記述が多い）。
 * 該当キーワードを含む文（改行・句点区切り）を最大60字程度で切り出す。無ければ null。
 */
function extractWorkStyleNote(bodyText: string, attachText: string): string | null {
  const t = (bodyText + '\n' + attachText).replace(/\r/g, '')
  const KW = /(?:フル)?リモート|在宅|テレワーク|常駐|出社/
  const m = KW.exec(t)
  if (!m) return null
  const idx = m.index
  let start = idx
  while (start > 0 && !/[\n。]/.test(t[start - 1]) && idx - start < 60) start--
  let end = idx
  while (end < t.length && !/[\n。]/.test(t[end]) && end - idx < 60) end++
  const phrase = t.slice(start, end).trim().replace(/^[・■※☆\s　>：:【\-]+/, '').replace(/[【】]/g, '').trim()
  return phrase || null
}

/**
 * ワークスタイル文から「客先常駐に出せるか」のざっくりタグを導出する。
 *   常駐可 / 併用可（ハイブリッド=一部出社可） / リモート希望（常駐は難しい） / null(不明)
 * あくまでヒント。判断材料の生フレーズ（extractWorkStyleNote）を必ず併記して人が正せる前提。
 */
function deriveWorkStyleTag(phrase: string | null): string | null {
  if (!phrase) return null
  const p = phrase
  const hasRemoteWord = /リモート|在宅|テレワーク/.test(p)
  const hasOnsiteWord = /常駐|出社/.test(p)
  const strictFullRemote = /フルリモート(?:のみ|必須|限定)|完全リモート|リモートのみ|常駐(?:不可|なし|NG|×)/.test(p)
  const onsiteOk = /常駐[　 ]?(?:可|OK|あり|可能)|フル常駐|出社[　 ]?(?:可|OK|可能|必須)|週[1-5][〜~－-]?\d?[　 ]?日?[　 ]?(?:出社|リモート)|月[1-9]回?[　 ]?(?:程度)?[　 ]?出社|尚可|相談可|併用|ハイブリッド|(?:初日|緊急時)[^\n]{0,4}出社|出社まで可/.test(p)
  if (strictFullRemote && !onsiteOk) return 'リモート希望'
  if (hasRemoteWord && (hasOnsiteWord || onsiteOk)) return '併用可'
  if (/フルリモート|完全リモート|リモート(?:のみ|必須|希望|優先|限定|前提|頻度高|メイン|ベース)/.test(p)) return 'リモート希望'
  if (hasOnsiteWord) return '常駐可'
  if (hasRemoteWord) return '併用可'
  return null
}

function extractFromProse(bodyText: string, attachText: string): {
  roles: string[]
  industries: string[]
  workStyle: string | null
} {
  // URL を除去（"https://example.com/cc.php" 等が PHP/HTTPS に誤マッチするのを防ぐ）
  const cleanedBody = stripUrlsForSkillMatching(bodyText)
  const cleanedAttach = stripUrlsForSkillMatching(attachText)
  const allText = cleanedBody + '\n' + cleanedAttach

  // 文章判定: 20文字超 or 読点・句点を含む行のみ抽出してスキャン
  // ただしスキルシートのフェーズ表ヘッダー行（"調査分析 要件定義 基本設計 ..." 等）は
  // 役割の false positive を引き起こすため除外する。
  // また Excel JSON 化で生成される「担当工程：xxx」等の工程キー行も除外する
  // （工程フェーズの値 "運用保守" 等が役割として誤抽出されるのを防ぐ）。
  const PROCESS_KEY_RE = /^(担当工程|担当フェーズ|参画工程|フェーズ|工程|作業工程|担当フェーズ|プロセス|process)[：:]/i
  const proseLines = allText.split(/\r?\n/).filter(
    l => (l.length > 20 || /[、。]/.test(l)) && !isPhaseTableHeader(l) && !PROCESS_KEY_RE.test(l),
  )
  const prose = proseLines.join('\n')

  const roles: string[] = []
  if (prose.trim()) {
    for (const { re, label } of PROSE_ROLES) {
      if (re.test(prose) && !roles.includes(label)) roles.push(label)
    }
  }

  // 業界判定もフェーズ表ヘッダー行を除外したテキストを対象にする
  // （以前は短い単語も拾うため全文対象だったが、誤検出が多いためフィルタ済みテキストに変更）
  const industryScanText = allText.split(/\r?\n/).filter(l => !isPhaseTableHeader(l)).join('\n')
  const industries: string[] = []
  for (const { re, label } of PROSE_INDUSTRIES) {
    if (re.test(industryScanText) && !industries.includes(label)) industries.push(label)
  }

  let workStyle: string | null = null
  for (const { re, label } of PROSE_WORKSTYLE) {
    if (re.test(allText)) { workStyle = label; break }
  }

  return { roles, industries, workStyle }
}


function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Base64データをUint8Arrayに変換 */
function base64ToUint8Array(base64: string): Uint8Array {
  // data:...;base64, 形式や空白を許容
  let s = base64.trim()
  const dataUrlIdx = s.indexOf('base64,')
  if (s.startsWith('data:') && dataUrlIdx >= 0) {
    s = s.slice(dataUrlIdx + 'base64,'.length)
  }
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  // padding
  const pad = s.length % 4
  if (pad === 2) s += '=='
  else if (pad === 3) s += '='
  else if (pad === 1) throw new Error('Invalid base64 length')

  const binary = atob(s)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** npm 動的 import の default / namespace 差を吸収 */
function npmDefault<T extends Record<string, unknown>>(mod: T): T {
  const d = mod as { default?: T }
  if (d.default && typeof d.default === 'object') {
    const def = d.default as Record<string, unknown>
    if (typeof def.read === 'function' || typeof def.extractRawText === 'function') return d.default as T
  }
  return mod
}

/**
 * .doc（旧バイナリ形式）からテキストを抽出するフォールバック
 * OLE2バイナリをUTF-16LEでデコードし日本語・ASCII文字列を抽出する
 */
function extractDocRawText(bytes: Uint8Array): string {
  try {
    const utf16 = new TextDecoder('utf-16le', { fatal: false }).decode(bytes)
    const matches = utf16.match(/[\u3000-\u9FFF\uFF00-\uFFEF\u30A0-\u30FF\u3040-\u309Fa-zA-Z0-9\s\u3001\u3002\uff0c\uff0e\uff1a\uff1b\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\u30fb\u2015\u2212\uff0d]{3,}/g) ?? []
    const result = matches.join(' ').replace(/\s+/g, ' ').trim()
    if (result.length > 50) {
      return result
    }
    return ''
  } catch {
    return ''
  }
}

/** Word(.docx/.doc)をテキストに変換 */
/** Word HTML を JSON 構造に変換する型 */
interface WordHtmlJson {
  tables: string[][][]   // tables[tableIdx][rowIdx][cellIdx]
  paragraphs: string[]   // テーブル外の段落テキスト
  cells: SpanCell[]      // colspan/rowspan を保持した結合セル情報（Excel の worksheetToCells 相当）
}

/**
 * mammoth の convertToHtml 出力を JSON 構造に変換する（node-html-parser 使用）。
 *
 * tables: テーブルごとに行・セルの2次元配列
 *   例: [[["氏名","山田太郎"],["最寄駅","渋谷"]], [["スキル","経験年数"],["Java","8年"]]]
 * paragraphs: テーブル外の段落テキスト一覧
 */
// セル内 <br> を \n に変換してテキスト抽出するヘルパー
function cellInnerText(el: { innerHTML: string }): string {
  return el.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim()
}

// 日本語履歴書の典型的なラベル語を検出するパターン
const WORD_LABEL_RE = /氏名|ふりがな|フリガナ|年齢|性別|住所|最寄|学歴|卒業|生年月|連絡先|電話番|メール|経験年|スキル|希望|単価|参画|勤務|国籍|資格|在住|案件名|環境・|役割|役職|規模|人数|担当工|期間|備考|補足|所属|会社名|企業名/

/** 値セル群を結合。全セルが1文字アルファベット（イニシャル）なら "H.S." 形式に */
function joinValueCells(valCells: string[]): string {
  if (valCells.length === 0) return ''
  const allInitials = valCells.length >= 2 && valCells.every(c => /^[A-Za-z]$/.test(c.trim()))
  if (allInitials) return valCells.map(c => c.trim()).join('.') + '.'
  return valCells.join(' ')
}

/**
 * テーブル行の cells を複数ラベル判定で分割して行文字列の配列を返す。
 *   ["氏　　名","H","S","性　　別","男"] → ["氏　　名：H.S.", "性　　別：男"]
 *   ["氏　　名","田中","太郎","性　　別","男"] → ["氏　　名：田中 太郎", "性　　別：男"]
 *   ["スキル","Java"] → ["スキル：Java"]
 */
function splitRowIntoLines(cells: string[]): string[] {
  if (cells.length <= 2) return [cells.join('：')]
  const lines: string[] = []
  let start = 0
  for (let i = 1; i < cells.length; i++) {
    const bare = cells[i].replace(/[\s　]/g, '')
    if (bare.length <= 8 && WORD_LABEL_RE.test(bare)) {
      // ラベル(start) + 値セル群を結合 → "氏名：田中 太郎" / "氏名：H.S."
      const label = cells[start]
      const valCells = cells.slice(start + 1, i)
      const values = joinValueCells(valCells)
      lines.push(values ? `${label}：${values}` : label)
      start = i
    }
  }
  const label = cells[start]
  const values = joinValueCells(cells.slice(start + 1))
  lines.push(values ? `${label}：${values}` : label)
  return lines.filter(l => l.trim())
}

/**
 * Word の <table> 1つを SpanCell[] に変換する（Excel の worksheetToCells 相当）。
 * colspan/rowspan を読み取り、結合セルの rowEnd/colEnd を正確に算出する。
 * HTML中間変換でも colspan/rowspan さえ保持されればExcelの !merges と同等の情報になる。
 */
function htmlTableToSpanCells(
  table: { querySelectorAll: (sel: string) => unknown[] },
  rowOffset: number
): { cells: SpanCell[]; rowCount: number } {
  const cells: SpanCell[] = []
  const occupied = new Set<string>()
  let r = 0
  const trs = table.querySelectorAll('tr') as Array<{ querySelectorAll: (sel: string) => unknown[] }>
  for (const tr of trs) {
    let c = 0
    const tds = tr.querySelectorAll('td, th') as Array<{ innerHTML: string; getAttribute: (n: string) => string | null }>
    for (const cellEl of tds) {
      while (occupied.has(`${r},${c}`)) c++
      const colspan = Math.max(1, parseInt(cellEl.getAttribute('colspan') || '1') || 1)
      const rowspan = Math.max(1, parseInt(cellEl.getAttribute('rowspan') || '1') || 1)
      const rEnd = r + rowspan - 1
      const cEnd = c + colspan - 1
      const value = cellInnerText(cellEl)
      if (value) cells.push({ row: r + rowOffset, col: c, colEnd: cEnd, rowEnd: rEnd + rowOffset, value })
      for (let rr = r; rr <= rEnd; rr++) {
        for (let cc = c; cc <= cEnd; cc++) occupied.add(`${rr},${cc}`)
      }
      c = cEnd + 1
    }
    r++
  }
  return { cells, rowCount: r }
}

async function htmlToWordJson(html: string): Promise<WordHtmlJson> {
  const { parse } = await import('npm:node-html-parser@6.1.13')
  const root = parse(html)

  const tables: string[][][] = []
  const cells: SpanCell[] = []
  let rowOffset = 0
  for (const table of root.querySelectorAll('table')) {
    const rows: string[][] = []
    for (const tr of table.querySelectorAll('tr')) {
      const rowCells = tr.querySelectorAll('td, th').map((cell: unknown) => cellInnerText(cell as unknown as { innerHTML: string })).filter(Boolean)
      if (rowCells.length > 0) rows.push(rowCells)
    }
    if (rows.length > 0) tables.push(rows)

    const { cells: tableCells, rowCount } = htmlTableToSpanCells(table as unknown as { querySelectorAll: (sel: string) => unknown[] }, rowOffset)
    cells.push(...tableCells)
    rowOffset += rowCount
  }

  const paragraphs: string[] = []
  for (const p of root.querySelectorAll('p, li')) {
    const text = cellInnerText(p as unknown as { innerHTML: string })
    if (text) paragraphs.push(text)
  }

  return { tables, paragraphs, cells }
}

/**
 * WordHtmlJson をフィールド抽出用テキストに変換する。
 *
 * 行内に複数ラベルがある場合は splitRowIntoLines で分割して出力。
 * セル内の \n（<br>由来）はそのまま保持。
 */
function wordJsonToText(json: WordHtmlJson): string {
  const lines: string[] = []
  // 段落（氏名・自己PR等の基本情報は通常テーブルより前に書かれている）を先に出力する。
  // テーブルを先にすると、案件履歴テーブルが長い経歴書で文字数上限
  // （cleanseWordTextのmaxChars等）に達し、末尾の基本情報が丸ごと切り捨てられる事故になる。
  for (const p of json.paragraphs) {
    lines.push(p)
  }
  for (const rows of json.tables) {
    for (const cells of rows) {
      for (const line of splitRowIntoLines(cells)) {
        lines.push(line)
      }
    }
  }
  return lines.join('\n')
}

/** Wordプロジェクト経歴テーブルから YYYY年MM月 / 現在 を収集して総月数を返す */
function parseYearMonth(s: string): Date | null {
  // 康熙部首の⽉(U+2F49/U+2F54)を標準の月(U+6708)に正規化してからマッチ
  const normalized = s.replace(/[\u2F00-\u2FFF]/g, c => {
    const map: Record<string, string> = { '\u2F49': '月', '\u2F54': '月', '\u2F22': '年' }
    return map[c] ?? c
  })
  const m = normalized.match(/(\d{4})年\s*(\d{1,2})月/)
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1)
  if (/^(現在|現職|present)$/i.test(s.trim())) return new Date()
  return null
}

/** セル全体から YYYY年MM月 / 現在 パターンをすべて抽出して Date[] で返す */
function extractDatesFromCell(cell: string): Date[] {
  const normalized = cell.replace(/[\u2F00-\u2FFF]/g, c => {
    const map: Record<string, string> = { '\u2F49': '月', '\u2F54': '月', '\u2F22': '年' }
    return map[c] ?? c
  })
  const results: Date[] = []
  // YYYY年MM月 を全件マッチ
  for (const m of normalized.matchAll(/(\d{4})年\s*(\d{1,2})月/g)) {
    results.push(new Date(parseInt(m[1]), parseInt(m[2]) - 1))
  }
  // "現在" / "現職" / "present" が含まれていれば今日を追加（重複防止のため1回だけ）
  if (results.length === 0 && /現在|現職|present/i.test(normalized)) {
    results.push(new Date())
  }
  return results
}

function calcWordProjectMonths(json: WordHtmlJson): number | null {
  // ヘッダーチェックなし：職歴テーブルはページ分割で複数テーブルに分かれるため全テーブルをスキャン
  const dates: Date[] = []
  for (const rows of json.tables) {
    for (const row of rows) {
      for (const cell of row) {
        for (const d of extractDatesFromCell(cell)) dates.push(d)
      }
    }
  }
  if (dates.length < 2) {
    return null
  }
  dates.sort((a, b) => a.getTime() - b.getTime())
  const min = dates[0], max = dates[dates.length - 1]
  const months = (max.getFullYear() - min.getFullYear()) * 12 + (max.getMonth() - min.getMonth())
  return months > 0 ? months : null
}

/**
 * WordHtmlJson の段落・セルから「スキル名 N年」パターンを抽出して
 * { スキル名: 月数 } を返す。
 *
 * 対象: カンマ/読点で区切られた各セグメント内で
 *   - "Laravel 4年" → { Laravel: 48 }
 *   - "React 4年, Next 3年" → { React: 48, Next: 36 }
 */
function extractWordSkillYears(json: WordHtmlJson): Record<string, number> {
  const result: Record<string, number> = {}
  const allTexts = [
    ...json.paragraphs,
    ...json.tables.flat(2),
  ]
  for (const text of allTexts) {
    const segments = text.split(/[,、，\n]/)
    for (const seg of segments) {
      const m = seg.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)年(?:[^\d]|$)/)
      if (!m) continue
      let skill = m[1].trim()
      // "フレームワーク/ライブラリ: Laravel" → "Laravel"（ラベルプレフィックス除去）
      const colonIdx = Math.max(skill.lastIndexOf(':'), skill.lastIndexOf('：'))
      if (colonIdx >= 0) skill = skill.slice(colonIdx + 1).trim()
      const years = parseFloat(m[2])
      if (skill && years > 0 && years <= 50 && !/^\d/.test(skill)) {
        result[skill] = Math.round(years * 12)
      }
    }
  }
  return result
}

/**
 * PDF抽出テキストの康熙部首・CJK部首補助の正規化。
 * PDF生成ソフト（Chrome印刷・一部のExcel/Word→PDF変換）はフォントの都合で
 * 「氏→⽒(U+2F92)」「西→⻄(U+2EC4)」のような部首コードポイントを出力することがあり、
 * そのままだと【氏名】・駅名・スキル名のregexが一切マッチしない（実PDFテストで発見）。
 * 康熙部首(U+2F00-2FD5)はNFKCで通常漢字に戻る。CJK部首補助(U+2E80-2EF3)はNFKC非対応のため、
 * 単独の漢字と見た目同形のものだけ明示マップで戻す（左偏用の⺅⺡等は単独漢字の代替に使われないので放置）。
 */
function normalizePdfRadicals(text: string): string {
  const RADICAL_FIX: Record<string, string> = {
    '⺠': '民', '⻁': '虎', '⻄': '西', '⻆': '角', '⻉': '貝', '⻑': '長', '⻘': '青', '⻗': '雨',
    '⻝': '食', '⻣': '骨', '⻤': '鬼', '⻥': '魚', '⻨': '麦', '⻩': '黄', '⻫': '斉', '⻭': '歯',
    '⻯': '竜', '⻲': '亀',
  }
  return text.replace(/[⺀-⿟]/g, (ch) => RADICAL_FIX[ch] ?? ch.normalize('NFKC'))
}

/**
 * PDF（base64）からテキストを抽出する。
 * スキャンPDF（画像のみ）の場合は空文字を返す。
 */
async function extractPdfText(base64: string): Promise<string> {
  try {
    const { extractText } = await import('npm:unpdf@1.6.2') as { extractText: (pdf: Uint8Array, opts?: { mergePages?: boolean }) => Promise<{ text: string; totalPages: number }> }
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const { text, totalPages } = await extractText(bytes, { mergePages: true })
    console.log(`[PDF] テキスト抽出完了: ${totalPages}ページ / ${text.length}文字`)
    return normalizePdfRadicals(text ?? '')
  } catch (e) {
    console.warn('[PDF] テキスト抽出失敗（スキャンPDF等）:', e instanceof Error ? e.message : String(e))
    return ''
  }
}

async function extractWordText(base64: string): Promise<{ text: string; totalProjectMonths?: number; skillYears?: Record<string, number>; grid?: string[][]; links?: { cell: string; url: string }[] }> {
  try {
    const mammothMod = npmDefault(await import('npm:mammoth@1.8.0'))
    const mammoth = mammothMod as {
      extractRawText?: (o: Record<string, unknown>) => Promise<{ value?: string }>
      convertToHtml?:  (o: Record<string, unknown>) => Promise<{ value?: string }>
    }
    if (!mammoth.extractRawText && !mammoth.convertToHtml) throw new Error('mammoth が見つかりません')

    const bytes = base64ToUint8Array(base64)
    if (bytes.byteLength === 0) throw new Error('Word添付のBase64が空です')

    const tryCall = async (fn: (o: Record<string, unknown>) => Promise<{ value?: string }>): Promise<string | null> => {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      try {
        return (await fn({ arrayBuffer: ab })).value ?? null
      } catch {
        const Buf = (globalThis as unknown as { Buffer?: { from: (u: Uint8Array) => unknown } }).Buffer
        if (Buf) return (await fn({ buffer: Buf.from(bytes) as unknown })).value ?? null
        return (await fn({ buffer: bytes as unknown })).value ?? null
      }
    }

    // convertToHtml を優先: テーブル構造をセル単位で保持できるため精度が高い
    if (mammoth.convertToHtml) {
      try {
        const html = await tryCall(mammoth.convertToHtml)
        if (html) {
          const wordJson = await htmlToWordJson(html)
          const text = wordJsonToText(wordJson)
          const totalProjectMonths = calcWordProjectMonths(wordJson) ?? undefined
          // Word・Excel 統合方式で skillYears 抽出（列名・配列・テキストパターンを全試行）
          const wordGrid = wordJson.tables.flat(1)
          const syGrid = extractSkillYearsUnified(wordGrid, wordJson.paragraphs)
          // SpanCell（colspan/rowspan保持）ベースでも抽出し、Excelと同じく品質スコアで勝者選択
          const syCells = filterSkillYears(extractSkillYearsFromCells(wordJson.cells))
          const countGrid = scoreSkillQuality(syGrid, _skillNameSet)
          const countCells = scoreSkillQuality(syCells, _skillNameSet)
          let skillYears: Record<string, number> = {}
          if (countCells > 0 || countGrid > 0) {
            skillYears = countCells >= countGrid ? syCells : syGrid
            if (syCells['_totalProjectMonths'] && !skillYears['_totalProjectMonths']) {
              skillYears['_totalProjectMonths'] = syCells['_totalProjectMonths']
            }
            if (syCells['_dateSpanMonths'] && !skillYears['_dateSpanMonths']) {
              skillYears['_dateSpanMonths'] = syCells['_dateSpanMonths']
            }
            // SpanCellベース勝者には経路コード50を付与（gridベースはUnified内で付与済み）
            if (skillYears['_extractMethod'] === undefined) skillYears['_extractMethod'] = 50
            console.log(`[Word-skillYears-pick] grid=${countGrid} cells=${countCells} winner=${countCells >= countGrid ? 'cells' : 'grid'}`)
          }
          // Word内のハイパーリンク（Excelのrels解析相当・名簿リンク型検出用）
          const wordLinks = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m, i) => ({ cell: `a${i + 1}`, url: m[1] }))
          return { text, totalProjectMonths, skillYears: Object.keys(skillYears).length > 0 ? skillYears : undefined, grid: wordGrid, links: wordLinks.length > 0 ? wordLinks : undefined }
        }
      } catch (e) {
        console.warn('[Word] convertToHtml 失敗、extractRawText へフォールバック', e)
      }
    }

    // フォールバック: extractRawText（従来動作）
    if (mammoth.extractRawText) {
      const text = await tryCall(mammoth.extractRawText)
      if (text) return { text }
    }

    throw new Error('mammoth いずれの変換も失敗')
  } catch (e) {
    console.warn('[Word] mammoth失敗、.doc バイナリ抽出へフォールバック', e)
    const bytes = base64ToUint8Array(base64)
    return { text: extractDocRawText(bytes) }
  }
}

/**
 * CSV文字列をAIが読みやすい形式にクレンジングする
 * - 空セルが大半の行を除去（スキルシートの広大な空白部分を削除）
 * - 連続する空行を1行に圧縮
 * - 各行のセルを「値1 / 値2 / ...」形式に整形（空セルは除外）
 * - 最大文字数を制限
 */
/** スキルシート関連キーワード（Excel向け行優先フィルター用） */
const SKILL_KEYWORDS = [
  // 技術系
  'Java', 'Python', 'JavaScript', 'TypeScript', 'Go', 'Rust', 'Ruby', 'PHP', 'Swift', 'Kotlin',
  'C++', 'C#', 'Scala', 'R言語', 'COBOL', 'VBA', 'SQL', 'HTML', 'CSS',
  'React', 'Vue', 'Angular', 'Next', 'Nuxt', 'Spring', 'Django', 'Rails', 'Laravel', 'FastAPI',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'Linux', 'Windows', 'Mac',
  'PostgreSQL', 'MySQL', 'Oracle', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB', 'BigQuery',
  'Git', 'GitHub', 'GitLab', 'Jenkins', 'CI/CD', 'Jira', 'Confluence', 'Slack',
  'TensorFlow', 'PyTorch', 'scikit', 'LLM', 'ChatGPT', 'Gemini', 'Bedrock',
  'Koa', 'Express', 'Flask', 'NestJS', 'GraphQL', 'REST', 'gRPC',
  // 業務・人材系
  '開発', '設計', '運用', '保守', 'テスト', 'レビュー', 'アーキテクチャ', 'インフラ',
  'プロジェクト', 'マネジメント', 'リーダー', 'スクラム', 'アジャイル', 'ウォーターフォール',
  'スキル', '経験', '期間', '年', 'ヶ月', '担当', '業務', '職務', '資格', '得意',
  '機械学習', '深層学習', 'データ分析', 'BI', 'ETL', 'バッチ', 'API', 'マイクロサービス',
]

/** 装飾・罫線系の記号パターン（Excelスキルシートによく含まれる） */
const DECORATION_RE = /^[\s★■□●◆◇▼▽△▲◎○※・－—─━═＝=\-─*#~_|/\\]+$/

function cleanseExcelCsv(csv: string, maxChars = 6000): string {
  const lines = csv.split('\n')
  const priorityLines: string[] = []  // スキル関連キーワードを含む行
  const otherLines: string[] = []     // その他の行
  let emptyLineCount = 0

  for (const line of lines) {
    // カンマ区切りでセルを分割し、空白・空セル・装飾のみセルを除去
    const cells = line.split(',')
      .map(c => c.trim().replace(/^"|"$/g, ''))  // クォート除去
      .filter(c => c !== '' && !DECORATION_RE.test(c))

    if (cells.length === 0) {
      if (emptyLineCount < 1) {
        otherLines.push('')
        emptyLineCount++
      }
      continue
    }

    emptyLineCount = 0

    const joined = cells.length === 1 ? cells[0] : cells.join(' / ')

    // スキル関連キーワードを含む行は優先バケツへ
    if (SKILL_KEYWORDS.some(kw => joined.includes(kw))) {
      priorityLines.push(joined)
    } else {
      otherLines.push(joined)
    }
  }

  // 優先行を先頭に、その他を後ろに結合
  const combined = [...priorityLines, '', ...otherLines]
  const result = combined.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return result.length > maxChars ? result.slice(0, maxChars) + '\n...(省略)' : result
}

/**
 * Word文書テキストをAIが読みやすい形式にクレンジング
 * - 連続する空行・スペースを圧縮
 * - ページ番号・ヘッダーフッターパターンを除去
 * - 連続する重複行を除去
 * - 最大文字数を制限
 */
function cleanseWordText(text: string, maxChars = 6000): string {
  const lines = text.split('\n')
  const cleaned: string[] = []
  let prevLine = ''
  let emptyLineCount = 0

  for (const rawLine of lines) {
    const line = rawLine
      // 連続スペース・全角スペースを1スペースに圧縮
      .replace(/[ \u3000\t]+/g, ' ')
      .trim()

    // ページ番号パターンを除去（「- 1 -」「1 / 5」「Page 1」「1ページ」等）
    if (/^[-\s]*\d+\s*[/／]\s*\d+[-\s]*$/.test(line)) continue
    if (/^[-\s]*\d+[-\s]*$/.test(line) && line.length <= 6) continue
    if (/^Page\s*\d+$/i.test(line)) continue
    if (/^\d+ページ$/.test(line)) continue

    // 装飾のみの行（罫線・区切り記号）を除去
    if (line.length > 0 && DECORATION_RE.test(line)) continue

    if (line === '') {
      // 空行は連続2行まで
      if (emptyLineCount < 1) {
        cleaned.push('')
        emptyLineCount++
      }
      continue
    }

    emptyLineCount = 0

    // 直前と同じ行（繰り返し）をスキップ
    if (line === prevLine) continue

    cleaned.push(line)
    prevLine = line
  }

  const result = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return result.length > maxChars ? result.slice(0, maxChars) + '\n...(省略)' : result
}

/** 期間テキスト（"10年9ヶ月" "10ヶ月" "1年" 等）を月数に変換 */
function parseDurationToMonths(text: string): number | null {
  if (!text || typeof text !== 'string') return null
  // <Nヶ月> / 【Nヶ月】 形式（S.H型: "<6ヶ月>"）の角括弧を除去して通常パターンで処理
  const t = text.trim().replace(/^[<【〈《「『](.+)[>】〉》」』]$/, '$1')
  let months = 0
  const yearMatch = t.match(/(\d+)\s*年/)
  const monthMatch = t.match(/(\d+)\s*[ヶかカヵｶ]月/)
  if (yearMatch) {
    const y = parseInt(yearMatch[1])
    // 50年超は西暦年（例: 2020年）の誤マッチとして無視
    if (y > 50) return null
    months += y * 12
  }
  if (monthMatch) months += parseInt(monthMatch[1])
  if (months > 0) return months
  // 漢数字・書き言葉の月数対応（O.Y型: 「六ヶ月」「一年九ヶ月」「二年六ヶ月」）
  const KANJI_NUM: Record<string, number> = {
    '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12,
  }
  const kanjiYear = t.match(/([一二三四五六七八九十]+)\s*年/)
  const kanjiMonth = t.match(/([一二三四五六七八九十]+)\s*[ヶかカヵｶ]月/)
  if (kanjiYear && KANJI_NUM[kanjiYear[1]] !== undefined) months += KANJI_NUM[kanjiYear[1]] * 12
  if (kanjiMonth && KANJI_NUM[kanjiMonth[1]] !== undefined) months += KANJI_NUM[kanjiMonth[1]]
  return months > 0 ? months : null
}

/**
 * 列構造が崩れて期間列・スキル列を検出できないExcel（ゲーム業界の自由記述型経歴書等）向けの
 * 最終フォールバック。セル値が「N年」「N年Mヶ月」等の期間表記だけで構成されている箇所を
 * 全セルから拾い集めて合算する。長文中の年数表記（誤爆防止のため）は対象にせず、
 * セル全体が期間表記のみの場合に限定する。
 */
function sumStandaloneDurationValues(rows: Array<Record<string, string>>): number {
  const STANDALONE_DURATION_RE = /^\d+年(?:\d+[ヶかカヵｶ]月)?$|^\d+[ヶかカヵｶ]月$/
  let total = 0
  const seen = new Set<string>()
  for (const row of rows) {
    for (const [key, rawValue] of Object.entries(row)) {
      const v = String(rawValue ?? '').trim()
      if (!STANDALONE_DURATION_RE.test(v)) continue
      const months = parseDurationToMonths(v)
      if (!months || months <= 0 || months > 600) continue
      const dedupeKey = `${key} ${v}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      total += months
    }
  }
  return total
}

/**
 * 上記と同じく列構造が崩れた自由記述型経歴書向けのフォールバック。
 * 「2016年5月〜2022年10月」のような日付範囲や単発の「YYYY年M月」表記を全セルから集め、
 * 最も古い年月から最も新しい年月（または「現在」）までのスパンを概算の総経験月数とする。
 * ※ 個々の案件期間を合算する方式（sumStandaloneDurationValues）は、同一在籍期間中の
 *   複数案件が重複してカウントされ過大評価になるリスクがあるため、これは併用しない。
 */
function estimateDateSpanMonthsFromRows(rows: Array<Record<string, string>>): number | null {
  const allText = rows.map(r => Object.values(r).join('\n')).join('\n')
  const yms: number[] = []
  const re = /(\d{4})年(\d{1,2})月/g
  let m: RegExpExecArray | null
  while ((m = re.exec(allText)) !== null) {
    const year = parseInt(m[1], 10)
    const month = parseInt(m[2], 10)
    if (year >= 1970 && year <= 2100 && month >= 1 && month <= 12) {
      yms.push(year * 12 + month)
    }
  }
  if (/現在|継続中/.test(allText)) {
    const now = new Date()
    yms.push(now.getFullYear() * 12 + (now.getMonth() + 1))
  }
  if (yms.length < 2) return null
  const span = Math.max(...yms) - Math.min(...yms)
  return span > 0 && span <= 600 ? span : null
}

/** Excelシリアル日付（整数）を "YYYY/M" 形式に変換 */
function excelSerialToDateStr(s: string): string {
  const n = parseInt(s)
  // 25569〜50000 = 1970年〜2036年の範囲のみ変換（誤認識防止）。
  // 旧下限36526(2000年)では1990年代開始のキャリア（F.K型の1987年〜等）が読めなかった
  if (isNaN(n) || n < 25569 || n > 50000) return s
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`
}

/** セル内に "2025年3月\n～\n2026年2月" 形式で開始〜終了が入っている場合に月数を抽出 */
function calcMonthsFromMultilineCell(cellValue: string): number | null {
  const parts = cellValue.split(/[\r\n]+/).map(s => s.trim())
    .filter(s => s && !/^[～~〜\-－]$/.test(s) && s !== '現在' && s !== '継続中')
  if (parts.length < 2) return null
  return calcMonthsFromDates(parts[0], parts[parts.length - 1])
}

/** 年月文字列を {year, month} に解析（元号プレフィックス・Excelシリアル・US日付形式に対応）
 *  戻り値型は sync_extractors のTS→JS変換の制約により注釈せず推論に任せる */
function parseYMParts(s: string) {
  // 和暦（昭和/平成/令和・S/H/R）+ 1〜2桁年は西暦に換算する。
  // 従来の「プレフィックス除去だけ」だと H30/4 → "30/4" → 2030年4月 と未来に誤変換されていた
  // （正: 平成30年 = 2018年）。3〜4桁年（R2020/04 等の誤記）は従来どおり除去して西暦扱い
  const eraM = s.trim().match(/^(昭和|平成|令和|[SsHhRr])\s*(\d{1,2}|元)\s*[\/\-年.]\s*(\d{1,2})/)
  if (eraM) {
    const offset = /^(?:昭和|[Ss])/.test(eraM[1]) ? 1925 : /^(?:平成|[Hh])/.test(eraM[1]) ? 1988 : 2018
    const year = offset + (eraM[2] === '元' ? 1 : parseInt(eraM[2]))
    const month = parseInt(eraM[3])
    if (month >= 1 && month <= 12 && year >= 1970 && year <= 2100) return { year, month }
  }
  // 元号プレフィックス（g=Gregorian表記・昭和/平成/令和アルファベット）を除去
  const cleaned = s.trim().replace(/^[gGhHrRsS]/, '')
  const normalized = excelSerialToDateStr(cleaned)
  // "/" "-" "年" に加えて "." も区切り文字として許容（例: "1991.10"）
  // 空白許容: mammoth(Word変換)がrun間に空白を挟むため「2008 年 5 月」形式が実在する
  const m = normalized.match(/(\d{2,4})\s*[\/\-年.]\s*(\d{1,2})/)
  if (m) {
    let year = parseInt(m[1])
    if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
    const month = parseInt(m[2])
    // 月の妥当性チェック（1〜12）が欠けていたため、日付ではない小数（案件行の参加人数・
    // 生の月数等。例: "38.53333333333333"）を「年.月」と誤読し、月=53のような無効値を
    // そのまま year*12+month の計算に使ってしまい、実在しない未来日付（2042年等）を
    // 作っていた実害があった（H.Rさん: 特許システム終了日が2012→2042に誤爆）
    if (month >= 1 && month <= 12 && year >= 1970 && year <= 2100) return { year, month }
  }
  // US 日付形式 M/D/YY or M/D/YYYY（Excel が日付セルを M/D/YY で出力するケース）
  const usm = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (usm) {
    const month = parseInt(usm[1])
    let year = parseInt(usm[3])
    if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
    if (month >= 1 && month <= 12 && year >= 1970 && year <= 2100) return { year, month }
  }
  return null
}

/** "2025/06" と "2026/03" のような開始・終了年月から月数を計算（Excelシリアル日付も対応） */
function calcMonthsFromDates(start: string, end: string): number | null {
  const s = parseYMParts(start)
  const e = parseYMParts(end)
  if (!s || !e) return null
  const months = (e.year - s.year) * 12 + (e.month - s.month) + 1
  return months > 0 ? months : null
}

/**
 * 抽出結果の品質スコア。方式の勝者選択を「件数」から「正しさの重み付き合計」に変える。
 * skill_master（名前+エイリアスの正規化Set）に載っているキー=3点、載っていないキー=1点。
 * 「ゴミを多く出す方式が、正確に少なく出す方式に勝つ」従来の件数比較の欠陥への対策。
 * masterSet が null（コールドスタート・ローカルテスト）のときは全キー1点=件数と同等に退化する。
 * masterSet の型は sync_extractors のTS→JS変換の制約で any（実体は Set<string> | null）
 */
// deno-lint-ignore no-explicit-any
function scoreSkillQuality(sy: Record<string, number>, masterSet: any = null): number {
  let score = 0
  for (const k of Object.keys(sy)) {
    if (k.startsWith('_')) continue
    if (masterSet && masterSet.has(k.toLowerCase().replace(/\s+/g, ''))) score += 3
    else score += 1
  }
  return score
}

/** 期間区間（year*12+month の開始・終了ペア）の和集合を月数化する。
 * 重複・並行期間は1回だけ数える。連続区間（前の終了月の翌月から開始）は結合されるため、
 * 重複が無い場合の合計は単純加算と完全に一致する */
function unionIntervalMonths(iv: number[][]): number {
  const sorted = iv.slice().sort((a, b) => a[0] - b[0])
  let total = 0
  let curS = sorted[0][0]
  let curE = sorted[0][1]
  for (let x = 1; x < sorted.length; x++) {
    const s2 = sorted[x][0]
    const e2 = sorted[x][1]
    if (s2 <= curE + 1) curE = Math.max(curE, e2)
    else { total += curE - curS + 1; curS = s2; curE = e2 }
  }
  return total + (curE - curS + 1)
}

/** Excel シートデータ（2D 配列）からスキル別経験月数を抽出
 * Method1: プロジェクト経歴型（「使用言語」列ヘッダーを持つ形式）
 * Method2: スキル一覧型（スキル名 | X年 が近接している形式）
 */
function extractSkillYearsFromSheetData(data: string[][]): Record<string, number> {
  // ── 事前スキャン: Excel上部の「IT経験」「経験年数」宣言セルを探す ──
  // 例: 「IT経験」「7年」が同行または隣接セルにある場合
  // ★ 早期 return せず、値を記録してから Method 1〜3 を続行する
  // （経験年数宣言があってもプロジェクト行からスキル別年数を取れる場合がある）
  let headerTotalMonths: number | null = null
  const EXP_LABEL = /IT経験|開発経験|エンジニア歴|経験年数|総経験|業務経験/
  for (let i = 0; i < Math.min(30, data.length); i++) {
    const row = data[i]
    for (let j = 0; j < row.length; j++) {
      const v = String(row[j] ?? '').trim()
      if (!EXP_LABEL.test(v)) continue
      // 凡例・定義行（「凡例：◎＝業務経験1年以上」等）は経験年数の宣言ではないためスキップ
      if (/凡例|◎＝|○＝|◇＝|△＝|▲＝/.test(v)) continue
      // 同セル内に年数が含まれる場合: "IT経験: 7年" など
      const inCell = parseDurationToMonths(v)
      if (inCell) { headerTotalMonths = inCell; break }
      // 隣接セル（右±3）に年数がある場合
      for (let k = j + 1; k <= Math.min(row.length - 1, j + 3); k++) {
        const adj = parseDurationToMonths(String(row[k] ?? ''))
        if (adj) { headerTotalMonths = adj; break }
      }
      if (headerTotalMonths) break
    }
    if (headerTotalMonths) break
  }

  // ── Method 1: プロジェクト経歴型 ──
  let langColIdx = -1
  let fwColIdx = -1
  let headerRowIdx = -1
  let durationColIdx = -1  // 「作業月数」等の純整数の月数列
  let startDateColIdx = -1
  let endDateColIdx = -1
  let noColIdx = -1  // 行番号列（通常 col[0] だが "No." ヘッダーが別列にある場合）
  let langColIdxFallback = -1
  let headerRowIdxFallback = -1
  for (let i = 0; i < Math.min(60, data.length); i++) {
    const row = data[i]
    for (let j = 0; j < row.length; j++) {
      // セル内改行がある場合は先頭行のみ使用（"言語\nDB" → "言語"）
      const v = String(row[j] ?? '').split(/[\r\n]/)[0].trim()
      // ヘッダーは通常20文字前後の短い単語。Word職務経歴書（改行のない自由文段落セル）で
      // 500文字超の長文の中にたまたま「言語」等の部分文字列が含まれるだけで、そのセル
      // 全体を言語ヘッダー列と誤認する実害があった（H.M型: 業務内容の長文が丸ごとスキル名
      // として誤爆・コロン付きゴミキー「リリース統括環境ＨＷ：SUN」等の温床になっていた）
      if (v.length > 30) continue
      // 全角スペース・半角スペースを除去した正規化ヘッダー（"言　　語" → "言語"）
      const vNorm = v.replace(/[\s　]+/g, '')
      // 複数行セルを結合した正規化ヘッダー（"作業\n月数" → "作業月数"）
      const vFull = String(row[j] ?? '').replace(/[\r\n]+/g, '').replace(/[\s　]+/g, '')
      // 全角ASCII→半角ASCII正規化（"ＯＳ/ＤＢ/言語" → "OS/DB/言語"）: TMK-S型対応
      const vAscii = vNorm.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      if ((vNorm.includes('使用言語') || vNorm === '言語' || vNorm.includes('使用技術') || vNorm.includes('技術スタック') || vNorm === '技術' || vNorm === '言語/技術'
           || vNorm.includes('開発言語') || vNorm.includes('PG言語')  // "OS・DB・開発言語" / "PG言語" 等の複合ヘッダー対応
           // 複合列ヘッダー対応: "言語　FW" / "言語/FW" / "言語・FW" / "言語 ツール" / "言語/DB" 等
           || (vNorm.includes('言語') && (vNorm.includes('FW') || vNorm.includes('ツール') || vNorm.includes('技術') || vNorm.includes('DB') || vNorm.includes('OS') || vNorm.includes('環境') || vNorm.includes('その他')))
           // 全角ASCII含む複合ヘッダー: "ＯＳ/ＤＢ/環境/言語/他" など（TMK-S型）
           || (vNorm.includes('言語') && (vAscii.includes('OS') || vAscii.includes('DB') || vAscii.includes('FW')))
           // "利用技術" / "機種/OS/DB等" / "OS/言語/DB" 等のヘッダー
           || vNorm.includes('利用技術') || /機種.*OS|OS.*言語|言語.*DB|言語.*OS/i.test(vNorm)
           // 全角ASCII正規化後の照合
           || /OS.*言語|言語.*OS|言語.*DB/i.test(vAscii)
         ) && langColIdx < 0) { langColIdx = j; headerRowIdx = i }
      // 「開発環境」は具体列名（言語・使用言語等）が最後まで見つからなかった場合の保険。
      // 「開発環境」は機種/OS/言語/DB/ツールをまとめた"グループ見出し"であることが多く（H.R型）、
      // 直接ヒットさせると本物の「言語」列より先にスキャンが打ち切られ、隣の「機種」列
      // （Win10等のOS名）が言語列として誤採用される実害があった。ループを抜けた後にだけ判定する
      if (vNorm.includes('開発環境') && langColIdxFallback < 0) { langColIdxFallback = j; headerRowIdxFallback = i }
      if ((vNorm.includes('FW') || vNorm.includes('ツール') || vNorm.includes('フレームワーク') || vNorm.includes('ミドル')) && fwColIdx < 0 && j !== langColIdx) fwColIdx = j
      // 純整数の月数列を検出（「作業月数」「月数」「期間（月）」「期間」等）
      // vFull も使うことで "作業\n月数" → "作業月数" のような改行含みヘッダーも検出できる（ＹＫ型）
      if ((/^作業月数$|^月数$|^期間[\(（]月|^期間$/.test(vNorm) || /^作業月数$|^月数$|^期間[\(（]月|^期間$/.test(vFull)) && durationColIdx < 0) durationColIdx = j
      // 作業期間列（"2017.04 ～ 2019.12" 形式の日付範囲を含む列）→ periodRangeColIdx として別途管理
      if ((/^作業期間$|^稼働期間$|^プロジェクト期間$|^PJ期間$|^参画期間$|^在籍期間$|^業務期間$|^開発期間$/.test(vNorm) || /^作業期間$|^稼働期間$|^プロジェクト期間$|^PJ期間$|^参画期間$|^在籍期間$|^業務期間$|^開発期間$/.test(vFull)) && durationColIdx < 0) durationColIdx = j
      // 開始・終了日付列（"終了年月：システム名" のような複合ヘッダーにも対応）
      if ((/^開始年月$|^開始$/.test(vNorm) || /^開始年月$|^開始$/.test(vFull)) && startDateColIdx < 0) startDateColIdx = j
      if ((/^終了年月$|^終了$/.test(vNorm) || /^終了年月$|^終了$/.test(vFull) || vNorm.startsWith('終了年月') || vNorm.startsWith('終了：')) && endDateColIdx < 0) endDateColIdx = j
      // 行番号列（"No." "No" "№" "項番" 等）。
      // 「項番」が未登録だったため noColIdx が見つからず、col[1]の値が日付にも
      // 継続行の終了日にもなる列でdurCellIsDate判定が誤って有効化され、プロジェクトの
      // 終了日だけの継続行が独立したデータ行として二重計上される実害があった（S.Y型）
      if ((/^(No\.?|No|№|番号|項目番号|項番)$/i.test(vNorm) || /^(No\.?|No|№|番号|項目番号|項番)$/i.test(vFull)) && noColIdx < 0) noColIdx = j
    }
    if (langColIdx >= 0) break
  }
  // 具体列名が最後まで見つからなかった場合のみ「開発環境」保険を採用（K.J型）
  if (langColIdx < 0 && langColIdxFallback >= 0) {
    langColIdx = langColIdxFallback
    headerRowIdx = headerRowIdxFallback
  }
  if (langColIdx >= 0) {
    const skillMonths: Record<string, number> = {}
    // スキルごとの期間記録: 日付が特定できた行は区間として貯め、後で和集合で月数化する。
    // 並行案件で同じスキルが複数行にあると単純加算では実年数（年齢）を超えるための対策。
    // 日付が取れない行（純整数の月数列等）は時間軸に置けないため従来どおり加算
    const skillIntervals: Record<string, number[][]> = {}
    const skillDatelessMonths: Record<string, number> = {}
    // プロジェクト期間の重複なし合計（経験年数推定用）
    const projectPeriods: Array<{ start: string; end: string; months: number; startYM: number | null; endYM: number | null }> = []
    let prevProcessedNo = ''  // マージセル重複スキップ用
    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const row = data[i]
      // noCell: col[0] の最初の行だけを使用（マルチライン "1\n(6ヶ月間)\n..." → "1"）
      // 丸数字（①②…⑳）も行番号として扱う（K.J型のWord経歴表）
      const circled = (s: string) => s.replace(/[①-⑳]/g, (c) => String(c.charCodeAt(0) - 0x2460 + 1))
      const noCell = circled(String(row[0] ?? '').split(/[\r\n]/)[0].trim()).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      // 通常: col[0] が行番号（数字）かどうか。
      // 例外1: 開始年月列が col[0] の場合（「開始年月」ヘッダーが検出済み）は日付でもOK
      // 例外2: "No." 列が col[0] 以外にある場合（noColIdx > 0）は該当列の値を確認
      const altNoCell = noColIdx > 0 ? circled(String(row[noColIdx] ?? '').trim()).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) : ''
      // durationColIdx に日付が入っているケース（行番号なし・noColIdx未検出）:
      // TMK-S型: 行番号なし、作業期間 col[0〜] に日付が直接入っているパターン
      const durDateRaw = durationColIdx >= 0 ? String(row[durationColIdx] ?? '').trim() : ''
      const durCellIsDate = durationColIdx >= 0 && noColIdx < 0 &&
        /^\d{4}[\/\-年.]\d{1,2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(durDateRaw)
      // O.M型: No列が無く行頭が空でも、言語セルが埋まっていて行内に日付があればデータ行。
      // M.N型: [2026][年][4][月] のように年月が別セルに分割される形式は結合してから判定
      const langCellPeek = String(row[langColIdx] ?? '').trim()
      // col[0]（行番号列）は結合対象から除外する。含めると行番号("3")が隣接の年("2023")と
      // 連結され「32023」のような架空の年になる実害があった（N.J型: 1987年に誤爆）
      const joinRowHead = (rw: string[]) => (rw ?? []).slice(1, 8).map((c) => String(c ?? '').trim()).join('')
      // 「) : null」で行が終わると sync_extractors が戻り値型注釈と誤認するため null 側を先に書く
      const joinedRowDate = langCellPeek === '' ? null : parseYMParts(joinRowHead(row))
      const rowAnyDate = langCellPeek !== '' && (joinedRowDate !== null || row.some((c, ci) => {
        if (ci === langColIdx) return false
        const t = String(c ?? '').trim()
        return t !== '' && t.length <= 40 && (parseYMParts(t) !== null || /^(現在|継続中?)$/.test(t))
      }))
      const isDataRow = /^\d+$/.test(noCell) ||
        (startDateColIdx === 0 && /\d/.test(noCell)) || // 開始日付が col[0] の場合
        (noColIdx > 0 && /^\d+$/.test(altNoCell)) || // "No." 列が別にある場合
        durCellIsDate ||  // TMK-S型: durationCol に日付がある場合（行番号なし）
        rowAnyDate  // O.M型
      const effectiveNoCell = noCell || altNoCell || (durCellIsDate ? durDateRaw : '') || (rowAnyDate ? 'D' : '')
      if (!effectiveNoCell || !isDataRow) continue
      // マージセルで同じ行番号が複数行に展開されている場合の重複スキップ
      // （A.I型: No.列が2,3列ともに"1"として展開される）
      if (noColIdx > 0 && altNoCell === prevProcessedNo) continue
      prevProcessedNo = altNoCell || noCell
      const langCell = String(row[langColIdx] ?? '').trim()
      const fwCell = fwColIdx >= 0 ? String(row[fwColIdx] ?? '').trim() : ''
      // この行の期間が日付として特定できたら記録する（スキル別の区間マージ用）
      let rowStartYM: number | null = null
      let rowEndYM: number | null = null
      const calcSpan = (a: string, bRaw: string): number | null => {
        // 「現在」「継続中」は今日の年月として扱う（現職案件）
        const b = /^(現在|継続中?|present)$/i.test(bRaw.trim())
          ? `${new Date().getFullYear()}/${new Date().getMonth() + 1}`
          : bRaw
        const m = calcMonthsFromDates(a, b)
        if (m) {
          const sP = parseYMParts(a)
          const eP = parseYMParts(b)
          if (sP && eP) { rowStartYM = sP.year * 12 + sP.month; rowEndYM = eP.year * 12 + eP.month }
        }
        return m
      }
      // calcMonthsFromMultilineCell と同じ分解ロジックで、日付の記録だけ追加したもの
      const spanFromMultiline = (cellValue: string): number | null => {
        const parts = cellValue.split(/[\r\n]+/).map(s => s.trim())
          .filter(s => s && !/^[～~〜\-－]$/.test(s) && s !== '現在' && s !== '継続中')
        if (parts.length < 2) return null
        return calcSpan(parts[0], parts[parts.length - 1])
      }
      // 期間は次の行の "10年9ヶ月" テキストから取得（最大3行後まで・col[1]とcol[2]を確認）
      let months: number | null = null
      // HM型: col[0] にマルチライン "1\n(6ヶ月間)\n..." 形式で期間が埋め込まれている場合
      {
        const col0Full = String(row[0] ?? '').trim()
        if (col0Full.includes('\n')) {
          months = parseDurationToMonths(col0Full) || null
        }
      }
      // ★ 作業月数列（純整数 or 日付範囲）が検出済みの場合は優先使用
      // ただし durationColIdx が行番号列（noColIdx=0 または col[0]）と同じ場合は純整数として使わない
      // （S.K型: 「期間」が col[0] だが data rows の col[0] は行番号 "1","2"... なのでその値は月数ではない）
      const durColIsRowNumCol = durationColIdx >= 0 && (durationColIdx === 0 || durationColIdx === noColIdx)
      if (durationColIdx >= 0) {
        const durRaw = String(row[durationColIdx] ?? '').trim()
        const durNum = parseInt(durRaw, 10)
        if (!durColIsRowNumCol && !isNaN(durNum) && durNum > 0 && durNum <= 600 && String(durNum) === durRaw) {
          months = durNum
          // 「期間」列は月数のはずが、実際には開始〜終了の日数が入っている表記が存在する
          // （H.H型: 例 開始/終了差2557日に対し「期間」列2569。総経験が数百年になる実害）。
          // 本物の開始・終了列が同じ行にあれば、そこから計算した月数と突き合わせ、
          // 「期間」列の値が日数（月数の目安20〜40倍）に見えるときはそちらを信頼する
          if (startDateColIdx >= 0 && endDateColIdx >= 0) {
            const dateSpan = calcSpan(String(row[startDateColIdx] ?? ''), String(row[endDateColIdx] ?? ''))
            if (dateSpan && dateSpan > 0 && durNum / dateSpan >= 20 && durNum / dateSpan <= 40) {
              months = dateSpan
            }
          }
        }
        // 期間列が日付範囲 "2017.04 ～ 2019.12" / "2020/04〜2023/03" 形式の場合
        if (!months) {
          // マルチライン（"2017.04\n～\n2019.12"）にも対応
          months = spanFromMultiline(durRaw)
          if (!months) {
            const rangeM = durRaw.match(/(.+?)\s*[〜～~\-－]+\s*(.+)/)
            if (rangeM) {
              const endVal = /現在|今|present|継続/i.test(rangeM[2]) ? new Date().getFullYear() + '/' + (new Date().getMonth() + 1) : rangeM[2]
              months = calcSpan(rangeM[1], endVal)
            }
          }
          // parseDuration も試す（"1年6ヶ月" 等）
          if (!months) months = parseDurationToMonths(durRaw)
        }
        // durationColIdx列が日付(>600)でmonthsがまだ未取得の場合、隣接列の純整数を月数として試用。
        // ただし [2026][年][4][月] の分割セル日付行（M.N型）では「4」を月数と誤認するため無効化
        if (!months && !joinedRowDate) {
          for (let adj = 1; adj <= 8 && !months; adj++) {
            const adjIdx = durationColIdx + adj
            if (adjIdx >= row.length) break
            const adjRaw = String(row[adjIdx] ?? '').trim()
            const adjNum = parseInt(adjRaw, 10)
            if (!isNaN(adjNum) && adjNum > 0 && adjNum <= 600 && String(adjNum) === adjRaw) {
              months = adjNum
            }
          }
        }
      }
      if (!months) {
        // TMK-S型（durCellIsDate=true）: durationColIdx に日付がある → ～行を探して終了日を見つける
        if (durCellIsDate) {
          const startDateStr = String(row[durationColIdx] ?? '').trim()
          let endDateStr = ''
          let durTextStr = ''
          for (let di = 1; di <= 20 && !months; di++) {
            if (i + di >= data.length) break
            const subRow = data[i + di]
            const subDurCell = String(subRow[durationColIdx] ?? '').trim()
            if (/^[〜～~]$/.test(subDurCell)) continue  // ～ 行はスキップ
            // 期間テキスト（"08年05ヶ月" 形式）優先
            const durParsed = parseDurationToMonths(subDurCell)
            if (durParsed && durParsed > 0) { months = durParsed; break }
            // 終了日（"2002/8" 形式）
            if (!endDateStr && /^\d{4}[\/\-年.]\d{1,2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(subDurCell)) {
              endDateStr = subDurCell
            } else if (endDateStr && di > 3) {
              // 終了日は見つかったがduration textがない → date計算で確定
              months = calcSpan(startDateStr, endDateStr); break
            }
            // 次のプロジェクト開始日（終了日確認後さらに新しい日付）が来たら終了
            if (endDateStr && /^\d{4}[\/\-年.]\d{1,2}/.test(subDurCell) && subDurCell !== endDateStr) {
              months = calcSpan(startDateStr, endDateStr); break
            }
          }
          if (!months && endDateStr) months = calcSpan(startDateStr, endDateStr)
        } else {
          // 同一行の日付ペアと近傍行の期間テキストを両方求めて突き合わせる（2026-07-20）:
          //  - 両方あり かつ ±2ヶ月で一致 → 日付ペアを採用（区間になり重複期間マージが効く）
          //  - 両方あり かつ 乖離 → 本人が明記した期間テキストを信頼（MK型: 日付ペアが実稼働と
          //    合わない行が実在。区間は信頼できないため日付なし扱い）
          //  - 片方のみ → ある方を採用（N_Y型: 旧テキスト優先では日付しか無い案件を数え漏れ）
          const pairMonths = calcSpan(String(row[1] ?? ''), String(row[3] ?? ''))
            ?? calcSpan(String(row[1] ?? ''), String(row[2] ?? ''))
          const pairStartYM = rowStartYM
          const pairEndYM = rowEndYM
          let textMonths: number | null = null
          const maxDi = durationColIdx >= 0 ? 5 : 3  // durationColIdx あり → 最大5行後まで確認
          for (let di = 1; di <= maxDi && !textMonths; di++) {
            if (i + di < data.length) {
              const subRow = data[i + di]
              // durationColIdx の列も確認（S.K/S.I型: 期間列に "4カ月" / "0年10ヶ月" が別行に入る）
              if (durationColIdx >= 0) {
                textMonths = parseDurationToMonths(String(subRow[durationColIdx] ?? ''))
              }
              if (!textMonths) {
                // col[0] も確認（HM型: 期間が "1\n(6ヶ月間)" → 次行 col[0] = "(6ヶ月間)"）
                textMonths = parseDurationToMonths(String(subRow[0] ?? ''))
                     ?? parseDurationToMonths(String(subRow[1] ?? ''))
                     ?? parseDurationToMonths(String(subRow[2] ?? ''))
              }
            }
          }
          if (pairMonths && textMonths) {
            if (Math.abs(pairMonths - textMonths) <= 2) {
              months = pairMonths
              rowStartYM = pairStartYM
              rowEndYM = pairEndYM
            } else {
              months = textMonths
              rowStartYM = null  // 区間として信頼できないため日付なし扱い（単純加算）
              rowEndYM = null
            }
          } else if (!months) {
            months = pairMonths ?? textMonths
            if (textMonths && !pairMonths) { rowStartYM = null; rowEndYM = null }
          }
        }
      }
      // col[1] に "2025年3月\n～\n2026年2月" 形式で開始〜終了が入っている場合
      if (!months) months = spanFromMultiline(String(row[1] ?? ''))
      // col[1] が日付範囲 "2017.04 ～ 2019.12" の場合（単一セル）
      if (!months) {
        const col1 = String(row[1] ?? '').trim()
        const rangeM1 = col1.match(/(.+?)\s*[〜～~\-－]+\s*(.+)/)
        if (rangeM1) {
          const endVal1 = /現在|今|present|継続/i.test(rangeM1[2]) ? new Date().getFullYear() + '/' + (new Date().getMonth() + 1) : rangeM1[2]
          months = calcSpan(rangeM1[1], endVal1)
        }
      }
      // 明示的な開始・終了列がある場合
      if (!months && startDateColIdx >= 0 && endDateColIdx >= 0) {
        months = calcSpan(String(row[startDateColIdx] ?? ''), String(row[endDateColIdx] ?? ''))
      }
      // col[1]/col[2] が開始・終了日付（M/D/YY形式 等）の場合
      if (!months) months = calcSpan(String(row[1] ?? ''), String(row[2] ?? ''))
      // col[1]/col[3] が別々の日付の場合（またはExcelシリアル日付）
      if (!months) months = calcSpan(String(row[1] ?? ''), String(row[3] ?? ''))
      // ペア行型: 次行の col[0] or col[1] が "～" で始まる場合、次行の col[1] or col[2] が終了日 (SH型・K.U型)
      if (!months && i + 1 < data.length) {
        const nextRow = data[i + 1]
        const nextCol0 = String(nextRow[0] ?? '').trim()
        const nextCol1 = String(nextRow[1] ?? '').trim()
        const nextCol2 = String(nextRow[2] ?? '').trim()
        if (/^[〜～~]/.test(nextCol0)) {
          // K.U型: nextRow[0]="～1996.3" or nextRow[0]="～", nextRow[1]="38657"
          const endDate = nextCol0.replace(/^[〜～~：:]+/, '').trim()
          if (endDate) months = calcSpan(String(row[1] ?? ''), endDate)
          if (!months) months = calcSpan(String(row[1] ?? ''), nextCol1)
          if (!months) months = calcSpan(String(row[1] ?? ''), nextCol2)
        } else if (/^[〜～~]/.test(nextCol1)) {
          // SH型: nextRow[1]="～", nextRow[2]=endSerial
          if (!months) months = calcSpan(String(row[1] ?? ''), nextCol2)
        }
        // K.U型2: nextRow[1] が "～YYYY.M" 形式
        if (!months && /^[〜～~]/.test(nextCol1)) {
          const endDate2 = nextCol1.replace(/^[〜～~：:]+/, '').trim()
          if (endDate2) months = calcSpan(String(row[1] ?? ''), endDate2)
        }
      }
      // 汎用横断走査（RH型）: 日付列の位置が不定でも、行内の日付セル（先頭16列）を集めて
      // 最初=開始・最後=終了とみなす。誤検出を避けるため2個以上あるときのみ
      if (!months) {
        const rowYMs: number[] = []
        for (let ci = 0; ci < Math.min(row.length, 16); ci++) {
          if (ci === langColIdx || ci === fwColIdx) continue
          const t = String(row[ci] ?? '').trim()
          if (!t || t.length > 40) continue
          if (/^(現在|継続中?)$/.test(t)) { rowYMs.push(new Date().getFullYear() * 12 + new Date().getMonth() + 1); continue }
          const p = parseYMParts(t)
          if (p) rowYMs.push(p.year * 12 + p.month)
        }
        if (rowYMs.length >= 2 && rowYMs[rowYMs.length - 1] >= rowYMs[0]) {
          const spanM = rowYMs[rowYMs.length - 1] - rowYMs[0] + 1
          if (spanM <= 600) {
            months = spanM
            rowStartYM = rowYMs[0]
            rowEndYM = rowYMs[rowYMs.length - 1]
          }
        }
      }
      // K.I型: durationCol（作業期間等）の列に日付が縦積み（開始→～→終了/現在）
      if (!months && durationColIdx >= 0) {
        const sC = parseYMParts(String(row[durationColIdx] ?? '').trim())
        if (sC) {
          for (let dj = 1; dj <= 3 && !months; dj++) {
            const v = String((data[i + dj] ?? [])[durationColIdx] ?? '').trim()
            if (!v || /^[〜～~\-－]+$/.test(v)) continue
            const eC = /^(現在|継続中?)$/.test(v)
              ? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
              : parseYMParts(v)
            if (eC) {
              const sI = sC.year * 12 + sC.month
              const eI = eC.year * 12 + eC.month
              if (eI >= sI && eI - sI <= 600) { months = eI - sI + 1; rowStartYM = sI; rowEndYM = eI }
            }
            break
          }
        }
      }
      // M.N型: 分割セル結合日付の縦積み（本行=開始・2〜3行下=終了。間の「～」行はスキップ）
      if (!months && joinedRowDate) {
        for (let dj = 1; dj <= 3 && !months; dj++) {
          const joined = joinRowHead(data[i + dj] ?? [])
          if (!joined || /^[〜～~\-－]+$/.test(joined)) continue
          const eJ = parseYMParts(joined)
          if (eJ) {
            const sI = joinedRowDate.year * 12 + joinedRowDate.month
            const eI = eJ.year * 12 + eJ.month
            if (eI >= sI && eI - sI <= 600) { months = eI - sI + 1; rowStartYM = sI; rowEndYM = eI }
          }
          break
        }
      }
      // 縦積み日付型（F.K型）: 開始日付が本行col[1]・終了日付が次行col[1]。
      // 次行が新しい案件行（col[0]が行番号）の場合は別案件の開始日と誤ペアになるため除外
      if (!months && i + 1 < data.length) {
        const nrow = data[i + 1] ?? []
        const nextNo = String(nrow[0] ?? '').split(/[\r\n]/)[0].trim()
        if (!/^\d+$/.test(nextNo)) {
          months = calcSpan(String(row[1] ?? ''), String(nrow[1] ?? ''))
        }
      }
      if (!months || months <= 0) continue
      projectPeriods.push({ start: String(row[1] ?? ''), end: String(row[3] ?? ''), months, startYM: rowStartYM, endYM: rowEndYM })
      // 【DBツール】等のセクション見出しは除去（IS型Word: 「【DBツール】GCP・BigQuery」対策）。
      // 中点・は「ASCIIを含むトークンのみ」さらに分割する（GCP・BigQuery は分割し、
      // 運用・保守 のような日本語複合語は壊さない）
      const rawSkillLines = (langCell + '\n' + fwCell).replace(/【[^】\n]*】/g, '\n')
        .split(/[\n\r、，,／]+/)
        .flatMap((s) => /[A-Za-z]/.test(s) ? s.split(/[・]/) : [s])
        .map(s => s.trim())
        .filter(s => s && s !== '-' && s !== '－' && !/^[\s\-－]+$/.test(s))
      const skillTexts: string[] = []
      for (const line of rawSkillLines) {
        // "OS : Windows NT" / "言語　：　Access/VBA" / "Server：日立、DELL、HP" 等の
        // 「カテゴリ: 値」形式を値部分だけ取り出す（F.K型: Server/PC ラベルが未対応で
        // ラベル込みの値がゴミキー化していた実害）
        const colonIdx = Math.max(line.lastIndexOf('：'), line.lastIndexOf(':'))
        if (colonIdx > 0 && colonIdx < line.length - 1) {
          const prefix = line.slice(0, colonIdx).replace(/[\s　]+/g, '')
          // OS/DB/言語/FW/MW等の短いカテゴリラベルの場合はコロン後を値として使う
          if (/^(OS|DB|言語|FW|MW|NW|環境|ツール|その他|Server|PC|サーバ|サーバー|機種|ハードウェア|HW|クラウド)$/i.test(prefix)) {
            const vals = line.slice(colonIdx + 1).split(/[\s　\/、]+/).map(s => s.trim()).filter(s => s.length >= 2)
            skillTexts.push(...vals)
            continue
          }
        }
        skillTexts.push(line)
      }
      const hasRowDates = rowStartYM !== null && rowEndYM !== null && rowEndYM >= rowStartYM
      for (const skill of skillTexts) {
        if (hasRowDates) {
          if (!skillIntervals[skill]) skillIntervals[skill] = []
          skillIntervals[skill].push([rowStartYM as number, rowEndYM as number])
        } else {
          skillDatelessMonths[skill] = (skillDatelessMonths[skill] ?? 0) + months
        }
      }
    }
    for (const skill of Object.keys(skillIntervals)) {
      skillMonths[skill] = (skillMonths[skill] ?? 0) + unionIntervalMonths(skillIntervals[skill])
    }
    for (const skill of Object.keys(skillDatelessMonths)) {
      skillMonths[skill] = (skillMonths[skill] ?? 0) + skillDatelessMonths[skill]
    }
    if (Object.keys(skillMonths).length > 0) {
      // プロジェクト合計月数を特殊キーとして付与（経験年数フォールバック用）
      // headerTotalMonths（上部宣言）が取れていれば優先的に使用
      if (headerTotalMonths && !skillMonths['_totalProjectMonths']) {
        skillMonths['_totalProjectMonths'] = headerTotalMonths
      }
      if (projectPeriods.length > 0) {
        // 総経験は「並行案件の月数を単純合計」ではなく、スキル別と同じくunion-mergeする。
        // 個人事業主・フリーランスが複数契約を並行稼働するケースで単純合計すると、
        // 実年齢を大きく超える総経験（H.H型: 588年）になっていた実害があった。
        // 日付区間のない行（期間テキストのみ）は従来どおり単純加算で埋め合わせる
        const periodsWithDates = projectPeriods.filter(p => p.startYM !== null && p.endYM !== null && (p.endYM as number) >= (p.startYM as number))
        const periodsWithoutDates = projectPeriods.filter(p => !(p.startYM !== null && p.endYM !== null && (p.endYM as number) >= (p.startYM as number)))
        const unionMonths = periodsWithDates.length > 0
          ? unionIntervalMonths(periodsWithDates.map(p => [p.startYM as number, p.endYM as number]))
          : 0
        const datelessSum = periodsWithoutDates.reduce((s, p) => s + p.months, 0)
        const totalProjectMonths = unionMonths + datelessSum
        if (!skillMonths['_totalProjectMonths']) skillMonths['_totalProjectMonths'] = totalProjectMonths
        // max日付 − min日付 スパン（空白期間込みのキャリア全体幅）
        const parseYM = (s: string) => {
          const m = s.match(/(\d{2,4})[\/\-年](\d{1,2})/)
          if (!m) return null
          let year = parseInt(m[1])
          if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
          return year * 12 + parseInt(m[2])
        }
        const starts = projectPeriods.map(p => parseYM(p.start)).filter((v): v is number => v !== null)
        const ends   = projectPeriods.map(p => parseYM(p.end)).filter((v): v is number => v !== null)
        if (starts.length > 0 && ends.length > 0) {
          const spanMonths = Math.max(...ends) - Math.min(...starts) + 1
          if (spanMonths > 0) skillMonths['_dateSpanMonths'] = spanMonths
        }
      }
      skillMonths['_extractMethod'] = 10  // Method 1: プロジェクト経歴型（列ヘッダー）
      return filterSkillYears(skillMonths)
    }
  }
  // ── Method 1.6: 複数年数列テーブル型（W.S/T.S/K.M型）──
  // ヘッダー行に「年数」が複数回現れ、各スキル種別（開発言語/DB/OS等）が横並びに配置される形式
  // 例: "開発言語 | 年数 | DB・FW | 年数 | OS | 年数" の各列ペアからスキルと年数を抽出
  {
    const YEAR_NUM_HEADER = /^年数$|^Years?$/i
    const SKIP_SKILL_HEADER = /^業務経験$|^業務工程$|^担当工程$|^役割$|^規模$|^人数$|^備考$|^その他$|^合計$|^環境[・ツール]?$/
    // ヘッダー行を探す: 「年数」が2回以上出現する行
    let m16HeaderRow = -1
    const m16YearCols: number[] = []   // 「年数」列の idx
    const m16SkillCols: number[] = []  // 各「年数」列に対応するスキル列 idx
    for (let i = 0; i < Math.min(40, data.length); i++) {
      const row = data[i]
      const yearIdxs: number[] = []
      for (let j = 0; j < row.length; j++) {
        const v = String(row[j] ?? '').replace(/[\r\n]+/g, '').replace(/[\s　]+/g, '')
        if (YEAR_NUM_HEADER.test(v)) yearIdxs.push(j)
      }
      if (yearIdxs.length >= 2) {
        m16HeaderRow = i
        for (const yj of yearIdxs) {
          // スキル列 = 年数列の直前に最も近い空でないセル（ただし別の年数列は除く）
          for (let k = yj - 1; k >= 0; k--) {
            const sv = String(row[k] ?? '').replace(/[\r\n]+/g, '').replace(/[\s　]+/g, '')
            if (!sv || yearIdxs.includes(k)) continue
            if (!SKIP_SKILL_HEADER.test(sv)) {
              m16YearCols.push(yj)
              m16SkillCols.push(k)
            }
            break
          }
        }
        if (m16YearCols.length >= 2) break
      }
    }
    if (m16HeaderRow >= 0 && m16YearCols.length >= 2) {
      const SM16: Record<string, number> = {}
      for (let i = m16HeaderRow + 1; i < data.length; i++) {
        const row = data[i]
        for (let ci = 0; ci < m16YearCols.length; ci++) {
          const yCol = m16YearCols[ci]
          const sCol = m16SkillCols[ci]
          const yearRaw = String(row[yCol] ?? '').trim()
          const yearsNum = parseFloat(yearRaw)
          if (isNaN(yearsNum) || yearsNum <= 0 || yearsNum > 50) continue
          const skillRaw = String(row[sCol] ?? '').trim()
          if (!skillRaw || skillRaw.length < 2 || /^\d+$/.test(skillRaw)) continue
          // スキルが複数行で記述されている場合は各行を個別に処理
          for (const skill of skillRaw.split(/[\r\n、，,]+/).map(s => s.trim()).filter(s => s && s.length >= 2 && !/^\d+$/.test(s))) {
            const mths = Math.round(yearsNum * 12)
            SM16[skill] = Math.max(SM16[skill] ?? 0, mths)
          }
        }
      }
      if (Object.keys(SM16).length > 0) {
        if (headerTotalMonths && !SM16['_totalProjectMonths']) SM16['_totalProjectMonths'] = headerTotalMonths
        SM16['_extractMethod'] = 16  // Method 1.6: 複数年数列テーブル型
        return filterSkillYears(SM16)
      }
    }
  }
  // ── Method 1.5: 項番ブロック型（KITAGAWA型）──
  // 「項番」が col[0] に出現し、各プロジェクトが複数行ブロックで記述されるパターン
  // 構造: 項番行 → 開始日行 → ～行 → 終了日行 → (N ） 行（月数）
  {
    const hasKoban = data.some(row => String(row[0] ?? '').trim() === '項番')
    if (hasKoban) {
      const SM15: Record<string, number> = {}
      let langColIdx15 = -1
      // lang列を検出: 項番行の直前にある「業務経歴」セクションヘッダー行で「言語」ヘッダーを探す
      // col[0]="言語" はスキルマトリクスの行ラベルなのでj>=1のものを優先
      const firstKobanRow = data.findIndex(row => String(row[0] ?? '').trim() === '項番')
      for (let i = Math.max(0, firstKobanRow - 5); i < firstKobanRow; i++) {
        for (let j = 1; j < data[i].length; j++) {
          const v = String(data[i][j] ?? '').split(/[\r\n]/)[0].trim()
          if ((v === '言語' || v.includes('使用言語') || v === '技術' || v === '言語/技術'
            || (v.includes('言語') && (v.includes('FW') || v.includes('DB') || v.includes('OS')))) && langColIdx15 < 0) {
            langColIdx15 = j
          }
        }
      }
      // セクションヘッダー行が見つからない場合は全体スキャン（j>=2のみ対象）
      if (langColIdx15 < 0) {
        for (let i = 0; i < Math.min(firstKobanRow < 0 ? 60 : firstKobanRow + 1, data.length); i++) {
          for (let j = 2; j < data[i].length; j++) {
            const v = String(data[i][j] ?? '').split(/[\r\n]/)[0].trim()
            if ((v === '言語' || v.includes('使用言語')
              || (v.includes('言語') && (v.includes('FW') || v.includes('DB') || v.includes('OS')))) && langColIdx15 < 0) {
              langColIdx15 = j
            }
          }
        }
      }
      for (let i = 0; i < data.length; i++) {
        const col0 = String(data[i][0] ?? '').trim()
        if (col0 !== '項番') continue
        // 次のブロック：当行および直後数行から開始日・終了日・月数・lang を取得
        let startDate = '', endDate = '', blockMonths: number | null = null
        const blockLang: string[] = []
        let inTilde = false
        // 項番行自体（di=0）から lang を取得（KITAGAWA型: lang が項番行と同じ行の結合セルに存在）
        if (langColIdx15 >= 0) {
          const lv0 = String(data[i][langColIdx15] ?? '').trim()
          if (lv0 && lv0 !== '-' && lv0 !== '－') blockLang.push(...lv0.split(/[\r\n、，,]+/).map(s => s.trim()).filter(s => s))
        }
        for (let di = 1; di <= 15 && i + di < data.length; di++) {
          const nrow = data[i + di]
          const nc0 = String(nrow[0] ?? '').trim()
          const nc1 = String(nrow[1] ?? '').trim()
          // 開始日（Excelシリアル or 日付形式 "4/1/06" / "2006/4" / "2006.4" 等）
          const isDateVal = (s: string) => /^\d{4,6}$/.test(s) || /^\d{1,4}[\/\-．年.]\d{1,2}/.test(s)
          if (!startDate && isDateVal(nc0)) startDate = nc0
          // ～ 行（"～" 単独または "〜"）
          if (/^[〜～~]$/.test(nc0)) { inTilde = true }
          // 終了日
          if (inTilde && !endDate && isDateVal(nc0) && nc0 !== startDate) endDate = nc0
          // (N ）形式の月数 → col[0]="(" col[1]="48" or "48 ヶ月"
          if (nc0 === '(') {
            const mNum = parseInt(nc1)
            if (!isNaN(mNum) && mNum > 0 && mNum <= 600) blockMonths = mNum
          }
          // lang列（マージセルで空になっている行は skip）
          if (langColIdx15 >= 0) {
            const lv = String(nrow[langColIdx15] ?? '').trim()
            if (lv && lv !== '-' && lv !== '－') blockLang.push(...lv.split(/[\r\n、，,]+/).map(s => s.trim()).filter(s => s))
          }
          // 次の「項番」行が来たら終了
          if (di > 1 && nc0 === '項番') break
        }
        if (!blockMonths && startDate && endDate) {
          blockMonths = calcMonthsFromDates(startDate, endDate)
        }
        if (!blockMonths || blockMonths <= 0) continue
        // 重複排除（マージセルにより同じスキルが複数行に現れるため）
        const uniqueSkills = [...new Set(blockLang)]
        for (const skill of uniqueSkills) {
          if (skill && skill.length >= 2 && !/^\d+$/.test(skill)) {
            SM15[skill] = (SM15[skill] ?? 0) + blockMonths
          }
        }
      }
      if (Object.keys(SM15).filter(k => !k.startsWith('_')).length > 0) {
        if (headerTotalMonths && !SM15['_totalProjectMonths']) SM15['_totalProjectMonths'] = headerTotalMonths
        SM15['_extractMethod'] = 15  // Method 1.5: 項番ブロック型
        return filterSkillYears(SM15)
      }
    }
  }
  // ── Method 1.7: KVブロック型（S.I型）──
  // 「No.|期間|内容」のブロックヘッダー行が案件ごとに繰り返され、期間は開始/終了の
  // 日付セル（Excelシリアル含む）、スキルは「環境」等の行ラベルの下のセルに書かれる形式。
  // 列ヘッダー前提のMethod 1では構造的に取れない。Excelステートマシン（spanCellsToJson）が
  // 読むKV/コンテナ構造のうち「期間×環境」パターンをグリッド上で直接マイニングする
  {
    const BLOCK_PERIOD_LABEL = /^(期間|プロジェクト期間|PJ期間|参画期間|在籍期間)$/
    const BLOCK_SKILL_LABEL = /^(環境|開発環境|使用環境|技術環境|使用言語|言語|使用技術)$/
    const normCell = (v: string) => String(v ?? '').split(/[\r\n]/)[0].replace(/[\s　]+/g, '').trim()
    // ブロックヘッダー行の検出: No.セルと期間セルが同一行に並ぶ
    const blockHeaderRows: number[] = []
    const blockSkillCols: number[] = []  // 見出し行の環境/言語系ラベルの列（-1=なし→期間列±3を探索）
    let blockPeriodCol = -1
    for (let i = 0; i < data.length; i++) {
      const row = data[i]
      let noIdx = -1
      let perIdx = -1
      for (let j = 0; j < row.length; j++) {
        const v = normCell(String(row[j]))
        if (/^(No\.?|№|項番|番号)$/i.test(v) && noIdx < 0) noIdx = j
        if (BLOCK_PERIOD_LABEL.test(v) && perIdx < 0) perIdx = j
      }
      // B.S型: 「No.」ラベルではなく行頭セルが整数そのもの + 期間ラベル + プロジェクト名/案件名ラベル
      let bsForm = false
      if (noIdx < 0 && perIdx >= 0) {
        const head = normCell(String(row[0]))
        const hasPjLabel = row.some((c) => /^【?(プロジェクト名|案件名)】?$/.test(normCell(String(c))))
        if (/^\d{1,3}$/.test(head) && hasPjLabel) bsForm = true
      }
      if ((noIdx >= 0 && perIdx > noIdx) || bsForm) {
        blockHeaderRows.push(i)
        if (blockPeriodCol < 0) blockPeriodCol = perIdx
        // 見出し行に環境/言語/ソフト系ラベルがあればその列をスキル探索対象として記録
        let skillCol = -1
        for (let j = 0; j < row.length; j++) {
          if (/環境|言語|使用ソフト|ツール/.test(normCell(String(row[j]))) && j !== perIdx) { skillCol = j; break }
        }
        blockSkillCols.push(skillCol)
      }
    }
    if (blockHeaderRows.length >= 1 && blockPeriodCol >= 0) {
      const intervals17: Record<string, number[][]> = {}
      const dateless17: Record<string, number> = {}
      const allIntervals: number[][] = []
      let allDateless = 0
      for (let b = 0; b < Math.min(blockHeaderRows.length, 30); b++) {
        const bStart = blockHeaderRows[b] + 1
        const bEnd = b + 1 < blockHeaderRows.length ? blockHeaderRows[b + 1] : Math.min(data.length, bStart + 25)
        // 期間の検出（優先順）:
        //  ① ブロック先頭データ行の期間列〜+12列の日付セル（最初=開始・最後=終了。S.I型）
        //  ② 期間列セル内の日付範囲 "2023/01～2023/05"（1セル型）
        //  ③ 期間列の縦積み日付（開始行・～行・終了行に分かれる型）
        //  「現在」「継続中」セルは今日の年月として扱う（現職案件）
        let sYM: number | null = null
        let eYM: number | null = null
        let blockMonths: number | null = null
        const nowYM = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
        {
          const dataRow = data[bStart] ?? []
          const ymList: number[] = []
          for (let j = blockPeriodCol; j < Math.min(dataRow.length, blockPeriodCol + 12); j++) {
            const cell = String(dataRow[j] ?? '').trim()
            const p = parseYMParts(cell)
            if (p) ymList.push(p.year * 12 + p.month)
            else if (/^(現在|継続中?|present)$/i.test(cell)) ymList.push(nowYM)
          }
          if (ymList.length >= 2 && ymList[ymList.length - 1] >= ymList[0]) {
            sYM = ymList[0]
            eYM = ymList[ymList.length - 1]
          }
        }
        // ② 期間列セル内の日付範囲（"2023/01～2023/05" / "2023/01〜現在"）
        if (sYM === null) {
          for (let r = bStart; r < bEnd; r++) {
            const cell = String((data[r] ?? [])[blockPeriodCol] ?? '').trim()
            const m = cell.match(/(.+?)\s*[〜～~\-－]+\s*(.+)/)
            if (!m) continue
            const sP = parseYMParts(m[1])
            const eP = /現在|継続|present/i.test(m[2]) ? { year: Math.floor((nowYM - 1) / 12), month: ((nowYM - 1) % 12) + 1 } : parseYMParts(m[2])
            if (sP && eP) {
              const s2 = sP.year * 12 + sP.month
              const e2 = eP.year * 12 + eP.month
              if (e2 >= s2) { sYM = s2; eYM = e2; break }
            }
          }
        }
        // ③ 期間列の縦積み日付（開始・終了が別行。「～」だけの行を挟む形も可）
        if (sYM === null) {
          const ymList: number[] = []
          for (let r = bStart; r < bEnd; r++) {
            const cell = String((data[r] ?? [])[blockPeriodCol] ?? '').trim()
            if (!cell) continue
            const p = parseYMParts(cell)
            if (p) ymList.push(p.year * 12 + p.month)
            else if (/^(現在|継続中?|present)$/i.test(cell)) ymList.push(nowYM)
          }
          if (ymList.length >= 2 && ymList[ymList.length - 1] >= ymList[0]) {
            sYM = ymList[0]
            eYM = ymList[ymList.length - 1]
          }
        }
        // フォールバック: ブロック内の期間列に "0年10ヶ月" 等の期間テキスト
        if (sYM === null) {
          for (let r = bStart; r < bEnd && !blockMonths; r++) {
            blockMonths = parseDurationToMonths(String((data[r] ?? [])[blockPeriodCol] ?? ''))
          }
        }
        if (sYM === null && !blockMonths) continue
        // スキル: ブロック内の「環境」等ラベルセルの右隣 + 同列の下方セルから収集。
        // ラベルは期間列の近傍（±3列）に限定する — 遠い列の「言語」等は経歴書フォームの
        // 別セクション（能力評価表・個人情報欄）のラベルで、誤発動の原因になる（H_O実害）
        // sync_extractors のTS→JS変換の制約により new Set<string>() 形式は使わない（型は変数側に注釈）
        const blockSkills: Set<string> = new Set()
        const skillColOfBlock = blockSkillCols[b] ?? -1
        for (let r = bStart; r < bEnd; r++) {
          const row = data[r] ?? []
          // 見出し行で特定したスキル列（B.S型: 期間列から遠い環境列）の値を直接収集
          if (skillColOfBlock >= 0) {
            const v = String(row[skillColOfBlock] ?? '').trim()
            if (v && !/環境|使用ソフト/.test(v)) {
              const cleaned = v.replace(/【[^】\n]*】/g, '\n')
              for (const line of cleaned.split(/[\r\n、，,\/／]+/)) {
                const t = line.trim().replace(/^[・\-\s　]+/, '').trim()
                if (!t || t.length < 2 || /^\d+$/.test(t)) continue
                if (/[：:]\s*$/.test(t) || /^[（(][^）)]*[）)]$/.test(t) || /^[ｦ-ﾟ]+$/.test(t)) continue
                blockSkills.add(t)
              }
            }
          }
          for (let j = Math.max(0, blockPeriodCol - 3); j <= blockPeriodCol + 3 && j < row.length; j++) {
            const rawCell = String(row[j] ?? '')
            const candidates: string[] = []
            // インライン型: 「環境：PHP/MySQL」のようにラベルと値が同一セル
            const inline = rawCell.trim().match(/^(環境|開発環境|使用環境|技術環境|使用言語|言語|使用技術)\s*[：:]\s*([\s\S]+)/)
            if (inline) {
              candidates.push(inline[2])
            } else if (BLOCK_SKILL_LABEL.test(normCell(rawCell))) {
              if (String(row[j + 1] ?? '').trim()) candidates.push(String(row[j + 1]))
              for (let r2 = r + 1; r2 < bEnd; r2++) {
                const v2 = String((data[r2] ?? [])[j] ?? '').trim()
                if (v2) candidates.push(v2)
              }
            } else {
              continue
            }
            for (const cand of candidates) {
              // 【環境/ツール】のようなセクション見出しは "/" 分割で壊れる前に丸ごと除去する
              const cleaned = cand.replace(/【[^】\n]*】/g, '\n')
              for (const line of cleaned.split(/[\r\n、，,\/／]+/)) {
                const t = line.trim().replace(/^[・\-\s　]+/, '').trim()
                if (!t || t.length < 2 || /^\d+$/.test(t)) continue
                if (/[：:]\s*$/.test(t)) continue          // 「能力指標：」等のラベル残骸
                if (/^[（(][^）)]*[）)]$/.test(t)) continue  // 「(遠隔操作用)」等の注記のみ
                if (/^[ｦ-ﾟ]+$/.test(t)) continue           // 半角カナのみ（ﾌﾘｶﾞﾅ等のフォームラベル）
                blockSkills.add(t)
              }
            }
          }
        }
        if (blockSkills.size === 0) continue
        if (sYM !== null && eYM !== null) {
          allIntervals.push([sYM, eYM])
          for (const sk of blockSkills) {
            if (!intervals17[sk]) intervals17[sk] = []
            intervals17[sk].push([sYM, eYM])
          }
        } else if (blockMonths) {
          allDateless += blockMonths
          for (const sk of blockSkills) {
            dateless17[sk] = (dateless17[sk] ?? 0) + blockMonths
          }
        }
      }
      const sm17: Record<string, number> = {}
      for (const sk of Object.keys(intervals17)) {
        sm17[sk] = (sm17[sk] ?? 0) + unionIntervalMonths(intervals17[sk])
      }
      for (const sk of Object.keys(dateless17)) {
        sm17[sk] = (sm17[sk] ?? 0) + dateless17[sk]
      }
      // フィルタ後の実スキルが3件以上のときだけ採用する。それ未満はブロック検出の
      // 誤発動（経歴書フォームの別表をブロックと誤認）の可能性が高く、早期returnすると
      // 後続のMethod 3/2が本来取れるはずの結果を潰してしまう（H_Oで実害を確認）
      const filtered17 = filterSkillYears(sm17)
      if (Object.keys(filtered17).filter(k => !k.startsWith('_')).length >= 3) {
        filtered17['_totalProjectMonths'] = headerTotalMonths
          ?? ((allIntervals.length > 0 ? unionIntervalMonths(allIntervals) : 0) + allDateless)
        filtered17['_extractMethod'] = 17  // Method 1.7: KVブロック型
        return filtered17
      }
    }
  }

  // ── Method 1.8: 期間|業務内容の繰り返し表型（M.K型のWord経歴書）──
  // 「期間|業務内容」だけの小表が案件ごとに繰り返される形式（mammoth変換のWord職歴書に多い）。
  // 環境ラベルが無いため、スキルは業務内容テキスト中のASCII技術語から拾い、期間はセル内の
  // 日付範囲から取る。技術語3件未満なら総経験のみ記録して他Methodへ委譲する（誠実な退化）
  {
    const PERIOD_H = /^(期間|開発期間|業務期間|作業期間)$/
    const CONTENT_H = /^(業務内容|担当業務|作業内容|職務内容|内容|担当フェーズ|環境・?言語等?)$/
    const normC = (v: string) => String(v ?? '').split(/[\r\n]/)[0].replace(/[\s　]+/g, '').trim()
    const hdrs: number[] = []
    for (let i = 0; i < data.length; i++) {
      const row = data[i] ?? []
      if (row.length >= 2 && PERIOD_H.test(normC(String(row[0]))) && row.slice(1).some((c) => CONTENT_H.test(normC(String(c))))) hdrs.push(i)
    }
    // ヘッダーが2回以上繰り返される場合のみこの型と認定（1回だけの通常表と誤判定しない）
    if (hdrs.length >= 2) {
      const iv18: Record<string, number[][]> = {}
      const dl18: Record<string, number> = {}
      const allIv: number[][] = []
      let allDl = 0
      const nowYM18 = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
      for (let b = 0; b < Math.min(hdrs.length, 30); b++) {
        const bS = hdrs[b] + 1
        const bE = b + 1 < hdrs.length ? hdrs[b + 1] : Math.min(data.length, bS + 12)
        let s18: number | null = null
        let e18: number | null = null
        let m18: number | null = null
        const toks: Set<string> = new Set()
        for (let r = bS; r < bE; r++) {
          for (const cRaw of data[r] ?? []) {
            const cell = String(cRaw)
            if (!cell.trim()) continue
            if (s18 === null && !m18) {
              const rg = cell.match(/([^\s〜～~]+)\s*[〜～~\-－]+\s*([^\s〜～~]+)/)
              if (rg) {
                const a = parseYMParts(rg[1])
                const z = /現在|継続|present/i.test(rg[2]) ? { year: Math.floor((nowYM18 - 1) / 12), month: ((nowYM18 - 1) % 12) + 1 } : parseYMParts(rg[2])
                if (a && z) {
                  const aa = a.year * 12 + a.month
                  const zz = z.year * 12 + z.month
                  if (zz >= aa) { s18 = aa; e18 = zz }
                }
              }
              if (s18 === null && !m18) m18 = parseDurationToMonths(cell)
            }
            // ASCII技術語トークン（日本語の一般語・会社名は対象外。精度はfilter+品質スコアで担保）。
            // 「TeraTermを使用」のように日本語が密着するため、分割ではなくASCII連続列を直接抽出する
            for (const mt of cell.matchAll(/[A-Za-z][A-Za-z0-9+.#-]{1,24}/g)) {
              toks.add(mt[0])
            }
          }
        }
        const months18 = s18 !== null && e18 !== null ? e18 - s18 + 1 : m18
        if (!months18 || months18 <= 0 || months18 > 600) continue
        if (s18 !== null && e18 !== null) allIv.push([s18, e18])
        else allDl += months18
        for (const t of toks) {
          if (s18 !== null && e18 !== null) {
            if (!iv18[t]) iv18[t] = []
            iv18[t].push([s18, e18])
          } else {
            dl18[t] = (dl18[t] ?? 0) + months18
          }
        }
      }
      const sm18: Record<string, number> = {}
      for (const k of Object.keys(iv18)) sm18[k] = (sm18[k] ?? 0) + unionIntervalMonths(iv18[k])
      for (const k of Object.keys(dl18)) sm18[k] = (sm18[k] ?? 0) + dl18[k]
      const total18 = (allIv.length > 0 ? unionIntervalMonths(allIv) : 0) + allDl
      const f18 = filterSkillYears(sm18)
      if (Object.keys(f18).filter(k => !k.startsWith('_')).length >= 3) {
        f18['_totalProjectMonths'] = headerTotalMonths ?? total18
        f18['_extractMethod'] = 18
        return f18
      }
      // スキルが作れなくても総経験だけは残す（関数末尾の最終フォールバックが拾う）
      if (!headerTotalMonths && total18 > 0) headerTotalMonths = total18
    }
  }

  // ── Method 1.9: セル内テキスト日付範囲型（H.M型のWord経歴表）──
  // 「役割（…2019年4月〜2020年3月…）| 内容」のように、期間がセルの文章中に埋め込まれた表。
  // 日付範囲を含む行が3行以上ある表を対象に、行=案件として ASCII技術語×期間で集計する
  {
    const RANGE_RE = /((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月|(?:19|20)\d{2}[\/.]\d{1,2})\s*[〜～~\-－]\s*(現在|継続中?|(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月|(?:19|20)\d{2}[\/.]\d{1,2})/
    const nowYM19 = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
    const rowsWithRange: Array<{ r: number; s: number; e: number }> = []
    for (let r = 0; r < data.length; r++) {
      for (const c of data[r] ?? []) {
        const cell = String(c)
        if (cell.length < 12 || cell.length > 1200) continue
        const mm = cell.match(RANGE_RE)
        if (!mm) continue
        const a = parseYMParts(mm[1])
        const z = /現在|継続/.test(mm[2]) ? { year: Math.floor((nowYM19 - 1) / 12), month: ((nowYM19 - 1) % 12) + 1 } : parseYMParts(mm[2])
        if (a && z) {
          const aa = a.year * 12 + a.month
          const zz = z.year * 12 + z.month
          if (zz >= aa && zz - aa <= 600) { rowsWithRange.push({ r, s: aa, e: zz }); break }
        }
      }
    }
    if (rowsWithRange.length >= 3) {
      const iv19: Record<string, number[][]> = {}
      const allIv19: number[][] = []
      for (const { r, s, e } of rowsWithRange.slice(0, 40)) {
        allIv19.push([s, e])
        const toks: Set<string> = new Set()
        const ROLE_ABBR = /^(PM|PL|PG|SE|PO|PMO|QA|TL|IT|OA|AI|IoT|FX|EC|BtoB|BtoC|SNS|No|OK|NG)$/i
        for (const c of data[r] ?? []) {
          for (const mt of String(c).matchAll(/[A-Za-z][A-Za-z0-9+.#-]{1,24}/g)) {
            if (!ROLE_ABBR.test(mt[0])) toks.add(mt[0])
          }
        }
        for (const t of toks) {
          if (!iv19[t]) iv19[t] = []
          iv19[t].push([s, e])
        }
      }
      const sm19: Record<string, number> = {}
      for (const k of Object.keys(iv19)) sm19[k] = unionIntervalMonths(iv19[k])
      const f19 = filterSkillYears(sm19)
      if (Object.keys(f19).filter(k => !k.startsWith('_')).length >= 3) {
        f19['_totalProjectMonths'] = headerTotalMonths ?? unionIntervalMonths(allIv19)
        f19['_extractMethod'] = 19
        return f19
      }
      if (!headerTotalMonths && allIv19.length > 0) headerTotalMonths = unionIntervalMonths(allIv19)
    }
  }

  // ── Method 3: スキル一覧型（経験年数列が数値のみ） ──
  // 例: "スキル名 | 5 | ◎" のように経験年数が整数で表現されている形式
  {
    const EXP_YEAR_HEADER = /^(経験年数|経験年|経験\(年\)|年数|年|Years?|Exp\.?|経験期間)$/i
    // 「ツール・言語・環境」等の複合列名にも対応（M.K型の「保有スキル」表: 分類|ツール・言語・環境|経験期間）
    const SKILL_COL_HEADER = /^(スキル名?|技術名?|使用技術|言語|技術スタック|item|技術項目|ツール[・･].{0,6}言語|.{0,6}言語[・･].{0,6}環境)$/i
    let expYrCol = -1
    let skillCol3 = -1
    let hdrRow3 = -1
    for (let i = 0; i < Math.min(60, data.length); i++) {
      const row = data[i]
      for (let j = 0; j < row.length; j++) {
        const v = String(row[j] ?? '').trim()
        if (EXP_YEAR_HEADER.test(v) && expYrCol < 0) { expYrCol = j; hdrRow3 = i }
        if (SKILL_COL_HEADER.test(v) && skillCol3 < 0) skillCol3 = j
      }
      if (expYrCol >= 0 && skillCol3 >= 0) break
    }
    if (expYrCol >= 0 && skillCol3 >= 0 && skillCol3 !== expYrCol) {
      const SM3: Record<string, number> = {}
      const BLOCKLIST3 = /^(自己PR|PR|備考|補足|資格|氏名|年齢|性別|国籍|住所|学歴|経歴|担当|役割|役職|ポジション|立場|評価|合計|スコア|レベル|プロジェクト名|企業名|規模|人数|期間|開始|終了|弊社社員|自社社員|社員|派遣|契約|フリー)$/
      for (let i = hdrRow3 + 1; i < data.length; i++) {
        const row = data[i]
        const expRaw = String(row[expYrCol] ?? '').trim()
        // 数値のみを年数として解釈（"5" → 60ヶ月、"2.5" → 30ヶ月）
        const yearsNum = parseFloat(expRaw)
        if (isNaN(yearsNum) || yearsNum <= 0 || yearsNum > 50) continue
        const skillName = String(row[skillCol3] ?? '').trim()
        if (!skillName || skillName.length < 2 || /^\d+$/.test(skillName) || BLOCKLIST3.test(skillName)) continue
        const months = Math.round(yearsNum * 12)
        SM3[skillName] = Math.max(SM3[skillName] ?? 0, months)
      }
      if (Object.keys(SM3).length > 0) {
        if (headerTotalMonths && !SM3['_totalProjectMonths']) SM3['_totalProjectMonths'] = headerTotalMonths
        SM3['_extractMethod'] = 30  // Method 3: スキル一覧型（数値列）
        return filterSkillYears(SM3)
      }
    }
  }

  // ── Method 2: スキル一覧型 ──
  // セクション見出し語（スキル名として誤採用しないもの）
  const SKILL_LABEL_BLOCKLIST = /^(自己PR|PR|アピールポイント|強み|備考|補足|資格|氏名|年齢|性別|国籍|住所|学歴|経歴|勤務先|担当|役割|役職|ポジション|立場|所属|評価|合計|スコア|レベル|備考欄|担当工程|プロジェクト名|案件名|企業名|会社名|規模|人数|期間|開始|終了|備考・コメント|弊社社員|自社社員|社員|派遣|契約|フリー)$/
  const isSkillLabelCandidate = (s: string): boolean =>
    s.length >= 2 && !/^\d+$/.test(s) && !/^[\s\-－◎○●▲×]+$/.test(s) && !SKILL_LABEL_BLOCKLIST.test(s)
  const skillMonths2: Record<string, number> = {}
  for (const row of data) {
    if (!row || row.length < 2) continue
    // 行内の「期間セル」位置を事前収集（隣のスキルの領域に越境しないための境界として使う）
    const durIdxs: number[] = []
    for (let j = 0; j < row.length; j++) {
      if (parseDurationToMonths(String(row[j] ?? ''))) durIdxs.push(j)
    }
    for (const j of durIdxs) {
      const months = parseDurationToMonths(String(row[j] ?? ''))!
      let matched = false
      // ① 左方向に境界探索（他の期間セルを跨いだら停止）: "スキル名 ... 期間" の一般的な並びを優先
      //    列間隔が広いシート（ラベルと値が3列以上離れている）でも正しく対応付けられる
      const prevDur = [...durIdxs].reverse().find(d => d < j)
      const leftBound = prevDur !== undefined ? prevDur + 1 : 0
      for (let k = j - 1; k >= leftBound; k--) {
        const candidate = String(row[k] ?? '').trim()
        if (isSkillLabelCandidate(candidate)) {
          skillMonths2[candidate] = Math.max(skillMonths2[candidate] ?? 0, months)
          matched = true
          break
        }
      }
      if (matched) continue
      // ② 左に見つからない場合: 従来通り右側 ±3 セルを探索（"期間 スキル名" の並びに対応）
      const nextDur = durIdxs.find(d => d > j)
      const rightBound = Math.min(row.length - 1, j + 3, nextDur !== undefined ? nextDur - 1 : row.length - 1)
      for (let k = j + 1; k <= rightBound; k++) {
        const candidate = String(row[k] ?? '').trim()
        if (isSkillLabelCandidate(candidate)) {
          skillMonths2[candidate] = Math.max(skillMonths2[candidate] ?? 0, months)
          break
        }
      }
    }
  }
  if (Object.keys(skillMonths2).length > 0) {
    if (headerTotalMonths && !skillMonths2['_totalProjectMonths']) skillMonths2['_totalProjectMonths'] = headerTotalMonths
    skillMonths2['_extractMethod'] = 20  // Method 2: 近接探索型（最後の受け皿・比率上昇は品質劣化のサイン）
    return filterSkillYears(skillMonths2)
  }

  // ── headerTotalMonths のみ取れた場合（スキル別年数なし）は早期リターン ──
  if (headerTotalMonths) return { _totalProjectMonths: headerTotalMonths }

  // ── 最終フォールバック: 日付の最小〜最大期間から総経験月数を算出 ──
  // シリアル日付（数値型）とテキスト日付（"2020/04"等）の両方を収集し、
  // 最も古い日付〜最も新しい日付の差分を総経験月数とみなす。
  // Wordの calcWordProjectMonths と同じ考え方（最小〜最大の引き算）
  {
    // 「年月の整数値（year*12+month）」に統一して比較
    const ymValues: number[] = []

    // Excelシリアル日付（整数で36526〜48000の範囲: 2000年〜2031年）をYM変換
    const SERIAL_MIN = 36526
    const SERIAL_MAX = 48000
    const serialToYM = (serial: number) => {
      // Excelシリアル日付 → JSのDate（1899-12-30基点）
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
      return d.getUTCFullYear() * 12 + d.getUTCMonth()
    }

    // テキスト日付パターン: "2020/04" "2020-04" "2020.04" "2020年4月" "2020年4"
    // g1991.10 のような元号プレフィックスも許容（g を除去）
    const TEXT_DATE_RE = /(?<![g\d])([gGhHrR]?\d{4})[\/\-年.](\d{1,2})(?:[月]|(?!\d))/

    for (const row of data) {
      for (const cell of row) {
        const raw = cell ?? ''
        // シリアル日付
        const num = parseFloat(String(raw))
        if (!isNaN(num) && num === Math.floor(num) && num >= SERIAL_MIN && num <= SERIAL_MAX) {
          ymValues.push(serialToYM(num))
          continue
        }
        // テキスト日付（g/h/r/s プレフィックスを除去してから年数をパース）
        const tm = String(raw).match(TEXT_DATE_RE)
        if (tm) {
          const y = parseInt(tm[1].replace(/^[gGhHrRsS]/, ''), 10), mo = parseInt(tm[2])
          if (y >= 1990 && y <= 2035 && mo >= 1 && mo <= 12) {
            ymValues.push(y * 12 + mo)
          }
        }
      }
    }

    if (ymValues.length >= 2) {
      const minYM = Math.min(...ymValues)
      const maxYM = Math.max(...ymValues)
      const months = maxYM - minYM
      if (months > 0 && months < 600) {
        return { _totalProjectMonths: months }
      }
    }
  }

  return {}
}

// ── Excel（SheetJS）直接→ JSON/グリッド変換ユーティリティ ────────────────────

/** セルアドレス (A1形式) を行・列インデックスから生成 */
function encodeXlsxCell(r: number, c: number): string {
  let col = ''
  let n = c + 1
  while (n > 0) {
    col = String.fromCharCode(((n - 1) % 26) + 65) + col
    n = Math.floor((n - 1) / 26)
  }
  return col + (r + 1)
}

/** "A1:CJ30" 形式の範囲文字列を { s, e } に変換 */
function decodeXlsxRange(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const decodeAddr = (addr: string) => {
    const m = addr.match(/^([A-Z]+)(\d+)$/)
    if (!m) return { r: 0, c: 0 }
    const col = m[1].split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1
    return { r: parseInt(m[2]) - 1, c: col }
  }
  const parts = ref.split(':')
  return { s: decodeAddr(parts[0]), e: decodeAddr(parts[1] || parts[0]) }
}

type XlsxMerge = { s: { r: number; c: number }; e: { r: number; c: number } }
type XlsxCell = { v?: unknown; w?: string }

/**
 * SheetJS worksheet から直接 2D グリッド（string[][]）を生成する。
 * sheet_to_html → parseHtmlTableToGrid の代替。HTML 経由をなくして中間変換ノイズを除去。
 * 結合セルの左上セルのみ値を出力し、非左上セルはスキップ（jagged gridになる）。
 */
function worksheetToGrid(sheet: Record<string, unknown>): string[][] {
  const ref = sheet['!ref'] as string | undefined
  if (!ref) return []
  const range = decodeXlsxRange(ref)
  const merges = (sheet['!merges'] as XlsxMerge[]) || []
  const skipCells = new Set<string>()
  for (const merge of merges) {
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r !== merge.s.r || c !== merge.s.c) skipCells.add(`${r},${c}`)
      }
    }
  }
  const grid: string[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (skipCells.has(`${r},${c}`)) {
        row.push('')  // 結合セル内部は空文字で列位置を保持（sheet_to_json の defval:'' と同等）
        continue
      }
      const cell = sheet[encodeXlsxCell(r, c)] as XlsxCell | undefined
      const val = String(cell?.w ?? (cell?.v !== undefined ? cell.v : '')).replace(/\r\n?/g, '\n').trim()
      row.push(val)
    }
    if (row.some(v => v)) grid.push(row)
  }
  return grid
}

/**
 * parseHtmlTableToGrid の出力（2D グリッド）を読みやすいテキストに変換する。
 * sheet_to_csv の代替。結合セルが正確に展開されているため構造が保たれる。
 * - 空セル・装飾セルを除去
 * - 連続する同値セル（colspan展開の重複）を排除
 * - 2セル行は「ラベル：値」形式、それ以外はスペース区切り
 * ※ フィールド抽出には gridToFieldText を使うこと（3列以上行のスペース結合問題を回避）
 */
function gridToText(grid: string[][], maxChars = 6000): string {
  const lines: string[] = []
  for (const row of grid) {
    const cells: string[] = []
    let prev = ''
    for (const c of row) {
      const v = c?.trim() ?? ''
      if (!v || DECORATION_RE.test(v)) continue
      if (v !== prev) cells.push(v)
      prev = v
    }
    if (cells.length === 0) continue
    lines.push(cells.length === 2 ? `${cells[0]}：${cells[1]}` : cells.join(' '))
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...(省略)' : text
}

/**
 * フィールド抽出用テキスト変換（HTML展開済みグリッド向け）
 * - 1セル行: そのまま出力
 * - 2セル行: 「ラベル：値」形式
 * - 3+セル行: 既知フィールドラベルを検出して隣の値とペア化し「ラベル：値」を複数行生成
 *   例: ["氏名","D.U","年齢","34","保有資格"] → "氏名：D.U\n年齢：34\n保有資格"
 */
function gridToFieldText(grid: string[][], maxChars = 6000): string {
  const FIELD_LABELS = new Set([
    'フリガナ','ふりがな','氏名','名前','お名前','年齢','性別','最寄駅','最寄り駅',
    '最終学歴','学歴','現住所','住所','居住地','経験年数','経験','希望単価','希望月額',
    '単価','希望稼働','稼働希望','参画時期','稼働時期','開始時期','自己PR','保有資格',
    '資格','国籍','備考','メモ','その他','スキルサマリ','サマリ','得意分野',
  ])
  const lines: string[] = []
  for (const row of grid) {
    const cells: string[] = []
    let prev = ''
    for (const c of row) {
      const v = c?.trim() ?? ''
      if (!v || DECORATION_RE.test(v)) continue
      if (v !== prev) { cells.push(v); prev = v }
    }
    if (cells.length === 0) continue
    if (cells.length === 1) {
      lines.push(cells[0])
    } else if (cells.length === 2) {
      lines.push(`${cells[0]}：${cells[1]}`)
    } else {
      // 3+セル: 既知ラベルを起点にペア化（次のセルも既知ラベルなら値と見なさずスキップ）
      let i = 0
      while (i < cells.length) {
        if (FIELD_LABELS.has(cells[i]) && i + 1 < cells.length && !FIELD_LABELS.has(cells[i + 1])) {
          lines.push(`${cells[i]}：${cells[i + 1]}`)
          i += 2
        } else {
          lines.push(cells[i])
          i++
        }
      }
    }
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...(省略)' : text
}


/** 2D グリッド → ヘッダー付き JSON 行配列（後方互換・extractSkillYearsUnified 内部から呼ばれる） */
// 戻り値型は sync_extractors のTS→JS変換の制約により注釈せず推論に任せる
function gridToJsonRows(grid: string[][]) {
  // 優先: プロジェクト表のヘッダー行（期間 / 開始 / 終了 / 言語 / OS / DB / FW を含む行）
  const PROJECT_HDR = /^(期間|プロジェクト期間|PJ期間|参画期間|在籍期間|作業期間|稼働期間|開始|開始年月|終了|終了年月|FROM|TO|使用言語|使用技術|言語|OS|DB|FW|ツール|フレームワーク|ミドル|作業月数|月数)$/i
  let headerIdx = -1
  // スコア最大のヘッダー候補行を選択（プロジェクト表ヘッダーを個人情報行より優先）
  let bestScore = -1
  for (let i = 0; i < Math.min(80, grid.length); i++) {
    const row = grid[i]
    const nonEmpty = row.map(v => v?.trim()).filter(v => v)
    if (nonEmpty.length < 2 || new Set(nonEmpty).size < 2) continue
    // プロジェクト表ヘッダースコア: PROJECT_HDR に一致するセル数
    const score = nonEmpty.filter(v => PROJECT_HDR.test(v.replace(/[\s　]+/g, ''))).length
    if (score > bestScore) { bestScore = score; headerIdx = i }
    // スコアが高い行が見つかったら早期終了（スコア≥2で十分）
    if (score >= 2) break
  }
  // フォールバック: 最初の2+ユニーク非空行
  if (headerIdx < 0) {
    headerIdx = grid.findIndex(row => {
      const nonEmpty = row.map(v => v?.trim()).filter(v => v)
      return nonEmpty.length >= 2 && new Set(nonEmpty).size >= 2
    })
  }
  if (headerIdx < 0) return []
  const headers = grid[headerIdx]
  const result: Array<Record<string, string>> = []
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i]
    if (!row?.some(v => v?.trim())) continue
    const obj: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      const k = headers[j]?.trim()
      if (k) obj[k] = row[j]?.trim() ?? ''
    }
    if (Object.keys(obj).length > 0) result.push(obj)
  }
  return result
}

interface SpanCell { row: number; col: number; colEnd: number; rowEnd: number; value: string }

/**
 * SheetJS worksheet から直接 SpanCell[] を生成する（sheet_to_html 経由なし）。
 * !merges を参照して結合情報を正確に取得する。HTML 中間変換による情報欠落を回避。
 */
function worksheetToCells(sheet: Record<string, unknown>): SpanCell[] {
  const cells: SpanCell[] = []
  const ref = sheet['!ref'] as string | undefined
  if (!ref) return cells
  const range = decodeXlsxRange(ref)
  const merges = (sheet['!merges'] as XlsxMerge[]) || []
  // merge の左上セル → rowEnd/colEnd
  const mergeInfo = new Map<string, { rowEnd: number; colEnd: number }>()
  const skipCells = new Set<string>()
  for (const merge of merges) {
    mergeInfo.set(`${merge.s.r},${merge.s.c}`, { rowEnd: merge.e.r, colEnd: merge.e.c })
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r !== merge.s.r || c !== merge.s.c) skipCells.add(`${r},${c}`)
      }
    }
  }
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (skipCells.has(`${r},${c}`)) continue
      const cell = sheet[encodeXlsxCell(r, c)] as XlsxCell | undefined
      const info = mergeInfo.get(`${r},${c}`)
      const rowEnd = info?.rowEnd ?? r
      const colEnd = info?.colEnd ?? c
      const val = String(cell?.w ?? (cell?.v !== undefined ? cell.v : '')).replace(/\r\n?/g, '\n').trim()
      if (val) cells.push({ row: r, col: c, colEnd, rowEnd, value: val })
    }
  }
  return cells
}

// ─── Excel ステートマシン ─────────────────────────────────────────────────
// 設計書: docs/ExcelStateMachine.md
// 状態: KEY_H / KEY_V / READ_COL_HEADERS / CONTAINER / KV_DONE / NEW_ROW / END

/**
 * 辞書A: 構造キー辞書（A ⊂ B）。常にキーとして出現し、値にはならない語。
 * KEY_H 条件3a の兄弟キー判定で使用。
 */
const STRUCTURE_KEY_DICT =
  /^(No\.?|計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始|終了|業務内容|内容|案件名|使用言語|使用技術|技術スタック|担当工程|規模|開発人数|備考|ポジション|チーム規模|担当業務|氏名|ふりがな|フリガナ|年齢|性別|住所|最寄駅?|学歴|最終学歴|卒業|生年月日?|連絡先|電話番号?|メールアドレス?|経験年数?|資格|保有資格|国籍|在住|所属|会社名|企業名|スキルサマリ[ー]?|自己PR|PR|アピールポイント|強み|希望勤務|希望単価|参画時期|稼働|業務経験|知識有り)$/

/**
 * 辞書B: タグ辞書（B ⊃ A）。構造キー＋スキル深掘り語＋サブラベルの全部入り。
 * 条件1（READ_COL_HEADERS）/ _isColTag（CONTAINER vs VALUE_COLLECT）で使用。
 * B \ A = スキル深掘り語（PM/TL 等）。キーにも値にもなる。
 */
const TAG_DICT =
  /^(No\.?|計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始|終了|業務内容|内容|案件名|使用言語|使用技術|技術スタック|担当工程|役割|規模|開発人数|ITコンサル|PM|PMO|TL|SE|PL|PG|マネージャー|リーダー|メンバー|備考|ポジション|チーム規模|担当業務|氏名|ふりがな|フリガナ|年齢|性別|住所|最寄駅?|学歴|最終学歴|卒業|生年月日?|連絡先|電話番号?|メールアドレス?|経験年数?|資格|保有資格|国籍|在住|所属|会社名|企業名|スキルサマリ[ー]?|自己PR|PR|アピールポイント|強み|希望勤務|希望単価|参画時期|稼働|補足|メモ|コメント|環境|言語|OS|DB|ツール|開発環境|フレームワーク|クラウド|インフラ|ミドルウェア|その他|立場|開発規模|人数|スキル|コンピュータ言語|サーバ[ー]?OS|業務経験|知識有り)$/

/** フェーズ評価列のみ（projectPhaseMap に登録する列。コンテンツ列=期間等は含めない） */
const PHASE_EVAL_RE =
  /^(計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守)$/

// ═══════════════════════════════════════════════════════════════════════
// 視覚エンジン（罫線・色・文字の複合信号でスキル年数を読む・語彙非依存）
// ローカル検証済み（scripts/parse_xlsx_cell_styles.mjs, _color_kv_reader.mjs,
// _visual_router.mjs / testData/excel 14件で回帰0件・KS 11→28正解に改善）を
// Deno(fflate)へ忠実に移植。失敗時は必ず null/空 を返し、呼び出し側は既存の
// grid/cells方式にフォールバックする（劣化させない安全設計）。
// ═══════════════════════════════════════════════════════════════════════

interface CellStyle {
  border: { L: string | null; R: string | null; T: string | null; B: string | null }
  fill: string | null
  bold: boolean
  fontColor: string | null
}

/** xlsx styles.xml をパースして borders/fills/fonts/cellXfs を返す（純関数） */
function parseXlsxStylesXml(stylesXml: string): {
  borders: CellStyle['border'][]
  fills: (string | null)[]
  fonts: { bold: boolean; color: string | null }[]
  cellXfs: { borderId: number; fillId: number; fontId: number }[]
} {
  const getBlock = (tag: string) => new RegExp(`<${tag}[\\s\\S]*?</${tag}>`).exec(stylesXml)?.[0] ?? ''
  const bBlock = getBlock('borders')
  const borderEls = bBlock.match(/<border(?:\s[^>]*)?>[\s\S]*?<\/border>/g) ?? []
  const getSide = (b: string, side: string) => new RegExp(`<${side}\\s+style="([^"]+)"`).exec(b)?.[1] ?? null
  const borders = borderEls.map((b) => ({ L: getSide(b, 'left'), R: getSide(b, 'right'), T: getSide(b, 'top'), B: getSide(b, 'bottom') }))

  const fBlock = getBlock('fills')
  const fillEls = fBlock.match(/<fill>[\s\S]*?<\/fill>/g) ?? []
  const fills = fillEls.map((f) => {
    const m = /fgColor rgb="([0-9A-Fa-f]{6,8})"/.exec(f)
    if (!m) return null
    return m[1].length === 8 ? m[1].slice(2) : m[1]
  })

  const fontsBlock = getBlock('fonts')
  const fontEls = fontsBlock.match(/<font>[\s\S]*?<\/font>/g) ?? []
  const fonts = fontEls.map((f) => {
    const bold = /<b\/>|<b\s/.test(f)
    const m = /<color[^>]*rgb="([0-9A-Fa-f]{6,8})"/.exec(f)
    let color = m ? m[1] : null
    if (color && color.length === 8) color = color.slice(2)
    return { bold, color }
  })

  const xBlock = getBlock('cellXfs')
  const xfEls = xBlock.match(/<xf\s[^>]*\/>|<xf\s[^>]*>[\s\S]*?<\/xf>/g) ?? []
  const cellXfs = xfEls.map((x) => ({
    borderId: Number(/borderId="(\d+)"/.exec(x)?.[1] ?? 0),
    fillId: Number(/fillId="(\d+)"/.exec(x)?.[1] ?? 0),
    fontId: Number(/fontId="(\d+)"/.exec(x)?.[1] ?? 0),
  }))
  return { borders, fills, fonts, cellXfs }
}

/** xl/workbook.xml + xl/_rels/workbook.xml.rels から シート名→実ファイル名(worksheets/sheetN.xml) を解決する（純関数） */
function resolveSheetXmlFile(workbookXml: string, relsXml: string, sheetName: string): string | null {
  const sheetEls = workbookXml.match(/<sheet\s[^>]*\/>/g) ?? []
  let rId: string | null = null
  for (const s of sheetEls) {
    const nameM = /name="([^"]*)"/.exec(s)
    if (nameM && nameM[1] === sheetName) {
      rId = /r:id="([^"]+)"/.exec(s)?.[1] ?? null
      break
    }
  }
  if (!rId) return null
  const relEls = relsXml.match(/<Relationship\s[^>]*\/>/g) ?? []
  for (const r of relEls) {
    if (new RegExp(`Id="${rId}"`).test(r)) {
      const target = /Target="([^"]+)"/.exec(r)?.[1]
      if (target) return target.startsWith('worksheets') ? `xl/${target}` : target.replace(/^\/?/, '')
    }
  }
  return null
}

/** セル参照(A1形式)ごとの罫線・色・文字書式マップを構築する（純関数） */
function buildCellStyleMap(sheetXml: string, styles: ReturnType<typeof parseXlsxStylesXml>, deadline = 0): Map<string, CellStyle> {
  const map = new Map<string, CellStyle>()
  const rowEls = sheetXml.match(/<row\s[^>]*>[\s\S]*?<\/row>/g) ?? []
  for (const row of rowEls) {
    if (deadline && Date.now() > deadline) break
    const cellEls = row.match(/<c\s[^>]*\/>|<c\s[^>]*>[\s\S]*?<\/c>/g) ?? []
    for (const c of cellEls) {
      const ref = /r="([A-Z]+\d+)"/.exec(c)?.[1]
      if (!ref) continue
      const s = Number(/\ss="(\d+)"/.exec(c)?.[1] ?? 0)
      const xf = styles.cellXfs[s] ?? { borderId: 0, fillId: 0, fontId: 0 }
      const border = styles.borders[xf.borderId] ?? { L: null, R: null, T: null, B: null }
      const fill = styles.fills[xf.fillId] ?? null
      const font = styles.fonts[xf.fontId] ?? { bold: false, color: null }
      map.set(ref, { border, fill, bold: font.bold, fontColor: font.color })
    }
  }
  return map
}

/**
 * xlsxバイト列から、指定シートのセル別スタイル(罫線・色・文字)マップを取得する。
 * SheetJSは背景色は取れるが罫線・線種・フォントを落とすため zip 直パースが必須。
 * 失敗時は null（呼び出し側は必ず既存方式にフォールバックする）。
 */
async function extractCellStylesFromXlsx(bytes: Uint8Array, sheetName: string, deadline = 0): Promise<Map<string, CellStyle> | null> {
  try {
    const { unzipSync } = await import('npm:fflate@0.8.2') as { unzipSync: (data: Uint8Array) => Record<string, Uint8Array> }
    const files = unzipSync(bytes)
    const decode = (u8?: Uint8Array) => (u8 ? new TextDecoder().decode(u8) : '')
    const workbookXml = decode(files['xl/workbook.xml'])
    const relsXml = decode(files['xl/_rels/workbook.xml.rels'])
    const stylesXml = decode(files['xl/styles.xml'])
    if (!workbookXml || !relsXml || !stylesXml) return null
    const sheetPath = resolveSheetXmlFile(workbookXml, relsXml, sheetName)
    if (!sheetPath || !files[sheetPath]) return null
    const sheetXml = decode(files[sheetPath])
    const styles = parseXlsxStylesXml(stylesXml)
    return buildCellStyleMap(sheetXml, styles, deadline)
  } catch (e) {
    console.warn('[visual-engine] スタイル取得失敗（既存方式にフォールバック）:', String(e))
    return null
  }
}

/** 絶対日付表記(2025年8月・2025/8等)の検出（案件系シグナル） */
const VISUAL_ABS_DATE_RE = /(?:19|20)\d{2}[年\/\-.]\d{1,2}/
/** 相対期間表記(4年4カ月・1カ月・10年以上・1-2年等)の検出（スキル系シグナル）。全体一致のみ＝単発日付混入を避ける */
const VISUAL_REL_DUR_RE = /^\d{1,2}年(?:\d{1,2}[ヶかカヵｶ]?月)?$|^\d{1,3}[ヶかカヵｶ]月$|^\d{1,2}年以上$|^\d(?:\.\d)?\s*[-〜～]\s*\d{1,2}(?:\.\d)?年$/
/** セルの罫線が「箱」を持つか（いずれかの辺に線種がある） */
const visualHasBorderBox = (b?: CellStyle['border']) => !!b && !!(b.L || b.R || b.T || b.B)

/**
 * コンテナ(シート)の視覚系統を判定する。語彙非依存、期間の書式だけを見る。
 *   - 相対期間(「4年4カ月」等)のセルが5件以上・絶対日付より多い → スキル系（明示スキル表）
 *   - または相対期間が3件以上で絶対日付がゼロ → スキル系（小さい明示スキル表。M.K型・4件など）。
 *     案件履歴ブロックは必ず案件期間の絶対日付を持つため、絶対日付ゼロは強いスキル表の証拠。
 *     誤って通っても視覚リーダー側が罫線ボックス＋列頻度3を要求するため空振り時はnullでgridに戻る。
 *   - それ以外 → 案件系（プロジェクト履歴表。期間は日付レンジで書かれる）
 * KS型（明示スキル表）とI.S型（案件履歴表）はこの書式差だけで実データ上分離できることを確認済み。
 */
function classifyContainerType(cells: SpanCell[]): 'skill' | 'project' {
  let rel = 0, abs = 0
  for (const c of cells) {
    const v = c.value.replace(/\s/g, '')
    if (VISUAL_ABS_DATE_RE.test(v)) abs++
    else if (VISUAL_REL_DUR_RE.test(v)) rel++
  }
  return (rel >= 5 && rel > abs) || (rel >= 3 && abs === 0) ? 'skill' : 'project'
}

/**
 * 空行（内容セルの無い行）を区切りとしてセル群をブロックに分割する。
 * ユーザーのKVコンテナ設計「空行＝コンテナの切れ目」を踏襲。混在シート（明示スキル表＋
 * 案件履歴表）を、シート全体の多数決ではなくブロック単位で判定するために使う。案件は
 * 「1案件＝1ブロック（日付2件ずつ）」に割れ、スキル表だけが「相対期間の塊・絶対日付ゼロ」の
 * ブロックとして浮かび上がるため、classifyContainerType をブロックに適用すると分離できる。
 */
function segmentBlocksByBlankRows(cells: SpanCell[]): SpanCell[][] {
  if (cells.length === 0) return []
  const contentRows = new Set<number>()
  let maxRow = 0
  for (const c of cells) {
    if (c.value.trim()) contentRows.add(c.row)
    if (c.rowEnd > maxRow) maxRow = c.rowEnd
  }
  const blocks: SpanCell[][] = []
  let curRows = new Set<number>()
  const flush = () => {
    if (curRows.size === 0) return
    const rs = curRows
    blocks.push(cells.filter((c) => rs.has(c.row)))
    curRows = new Set<number>()
  }
  for (let r = 0; r <= maxRow; r++) {
    if (contentRows.has(r)) curRows.add(r)
    else flush()
  }
  flush()
  return blocks
}

/** 相対期間表記(全体一致)のみを厳密に月数へ変換する（曖昧一致を避けるための専用パーサ） */
function strictDurationToMonths(s: string): number | null {
  const t = s.trim().replace(/\s/g, '')
  const ym = /^(\d{1,2})年(\d{1,2})[ヶかカヵｶ]?月$/.exec(t)
  if (ym) return Number(ym[1]) * 12 + Number(ym[2])
  const ijou = /^(\d{1,2})年以上$/.exec(t) // 「10年以上」→ 10年（明示スキル表の年数欄に多い）
  if (ijou) return Number(ijou[1]) * 12
  const range = /^\d(?:\.\d)?[-〜～](\d{1,2}(?:\.\d)?)年$/.exec(t) // 「1-2年」「0.5-1年」→ 上限を採用
  if (range) return Math.round(Number(range[1]) * 12)
  const y = /^(\d{1,2})年$/.exec(t)
  if (y) return Number(y[1]) * 12
  const m = /^(\d{1,3})[ヶかカヵｶ]月$/.exec(t)
  if (m) return Number(m[1])
  return null
}

/**
 * 視覚色KVリーダー（罫線＋色＋文字の複合信号でスキル年数を直読み。語彙非依存）。
 * 明示スキル表（KS型: 「スキル名｜年月」が罫線の箱で並ぶ表）専用。案件系コンテナには使わない
 * （classifyContainerTypeで'skill'と判定された場合のみ呼び出すこと）。
 *   1. シート内で繰り返し出る「見出し色」を自己学習（非白fillが3セル以上のもの）
 *   2. 見出し色でない・罫線の箱を持つセルをスキル候補とし、同じ行の右隣で期間セルとペアリング
 *   3. 列ペア(スキル列,期間列)の出現回数が3行未満（単発）のペアは不採用
 *      （経験年数/歳/駅名等の単発ラベル誤爆を、語彙ではなく「テーブルの密度」で排除する）
 */
function extractSkillYearsVisualKV(cells: SpanCell[], styleMap: Map<string, CellStyle>): Record<string, number> {
  const styled = cells.map((c) => ({
    ...c,
    ...(styleMap.get(encodeXlsxCell(c.row, c.col)) ?? { border: { L: null, R: null, T: null, B: null }, fill: null, bold: false, fontColor: null }),
  }))
  const fillCount: Record<string, number> = {}
  for (const c of styled) {
    if (!c.fill) continue
    const f = c.fill.toUpperCase()
    if (f === 'FFFFFF') continue
    fillCount[f] = (fillCount[f] ?? 0) + 1
  }
  const headerColors = new Set(Object.entries(fillCount).filter(([, n]) => n >= 3).map(([f]) => f))
  // 見出し判定は「色」だけに頼らない。本文セルは表の罫線ボックスの中にある（縞・強調で
  // 色が付いていても罫線は一様）。fill色だけで見出し扱いすると、KS型のゼブラ縞や本人が
  // 強調のために塗ったスキル行を丸ごと捨ててしまう（実データで確認）。よって「見出し色」は
  // 罫線ボックスを持たないセルにのみ適用する。真の見出し行（カテゴリ|項目|経験年数 等）は
  // 期間セルと対にならず strictDurationToMonths が null になるため構造的に除外される。
  const isHeader = (c: (typeof styled)[number]) =>
    !!c.fill && headerColors.has(c.fill.toUpperCase()) && !visualHasBorderBox(c.border)

  const isSkillCandidate = (name: string): boolean => {
    const n = name.replace(/^[\s　・\-]+/, '').trim()
    if (!n) return false
    if (/^\d+$/.test(n)) return false
    if (n.length > 25) return false
    if (VISUAL_REL_DUR_RE.test(n)) return false
    if (VISUAL_ABS_DATE_RE.test(n)) return false
    if (/^[-―ー~〜、。：:／\/]+$/.test(n)) return false
    return true
  }

  const pairs: { skillCol: number; durCol: number; skill: string; months: number }[] = []
  const byRow: Record<number, (typeof styled)> = {}
  for (const c of styled) (byRow[c.row] ??= []).push(c)
  for (const rcells of Object.values(byRow)) {
    rcells.sort((a, b) => a.col - b.col)
    for (let i = 0; i < rcells.length; i++) {
      const sc = rcells[i]
      if (isHeader(sc) || !visualHasBorderBox(sc.border) || !isSkillCandidate(sc.value)) continue
      for (let j = i + 1; j < rcells.length; j++) {
        const dc = rcells[j]
        if (isSkillCandidate(dc.value)) break
        const months = strictDurationToMonths(dc.value)
        if (months !== null && months >= 1 && months <= 600 && visualHasBorderBox(dc.border) && !isHeader(dc)) {
          const skill = sc.value.replace(/^[\s　・\-]+/, '').trim().replace(/\n[\s\S]*/, '')
          pairs.push({ skillCol: sc.col, durCol: dc.col, skill, months })
          break
        }
      }
    }
  }
  const colFreq: Record<string, number> = {}
  for (const p of pairs) colFreq[`${p.skillCol},${p.durCol}`] = (colFreq[`${p.skillCol},${p.durCol}`] ?? 0) + 1
  const result: Record<string, number> = {}
  for (const p of pairs) {
    if ((colFreq[`${p.skillCol},${p.durCol}`] ?? 0) < 3) continue
    if (p.skill.length > 20) continue
    result[p.skill] = Math.max(result[p.skill] ?? 0, p.months)
  }
  return result
}

/**
 * 視覚エンジンでの抽出を試みる。スキル系コンテナと判定され、かつ結果が得られた場合のみ
 * 値を返す。それ以外（判定失敗・案件系・スタイル取得失敗・0件）は null を返し、
 * 呼び出し側は必ず既存の grid/cells 方式にフォールバックする（劣化させない安全設計）。
 */
async function tryVisualSkillExtraction(bytes: Uint8Array, sheetName: string, cells: SpanCell[], deadline = 0): Promise<Record<string, number> | null> {
  if (deadline && Date.now() > deadline) return null
  const styleMap = await extractCellStylesFromXlsx(bytes, sheetName, deadline)
  if (!styleMap) return null
  if (deadline && Date.now() > deadline) return null
  // 空行でブロック分割し、skill系ブロックだけを視覚リーダーで読む（混在シート対応）。
  // シート全体では案件履歴の日付数に負けて 'project' になる表でも、スキル表ブロックは
  // 単体で 'skill' 判定されるため拾える。複数の skill ブロックがあれば union する。
  const skillBlocks = segmentBlocksByBlankRows(cells).filter((b) => classifyContainerType(b) === 'skill')
  // 後方互換: ブロック分割で拾えない単一表(KS型等)はシート全体で従来判定にフォールバック。
  const targets = skillBlocks.length > 0
    ? skillBlocks
    : (classifyContainerType(cells) === 'skill' ? [cells] : [])
  if (targets.length === 0) return null
  const merged: Record<string, number> = {}
  for (const blk of targets) {
    if (deadline && Date.now() > deadline) break
    const r = extractSkillYearsVisualKV(blk, styleMap)
    for (const [k, v] of Object.entries(r)) merged[k] = Math.max(merged[k] ?? 0, v)
  }
  // 明示スキル表は必ず複数スキルが縦に並ぶ。抽出結果が2件以下の場合は「役割別の経験年数
  // サマリ（PG:6年 / PG,SE,PM:14年 等）」を誤検出している可能性が高いので採用しない。
  // 語彙で役割語を弾くのではなく、テーブルの件数（構造）で弾く。実データ上、真のスキル表は
  // 最小でも4件（M.K型）だったため3件を下限とする。
  return Object.keys(merged).length >= 3 ? merged : null
}

// ===== 案件系スキル年数 視覚プロジェクトリーダー =====
// スキル表を持たない「案件履歴フォーマット」向け。縦結合セル(rowspan)で「1案件=複数行ブロック」を
// 認識し、ブロック内の期間(開始〜終了/期間)を、ブロック内の tech(指定列＋【】自由記述)に区間unionで与える。
// 人間が「罫線で囲まれた塊=1案件」と見るのを再現。gridには無い機能（罫線・結合が見えないため）。
// 信頼ゲート: tech列2本以上＋案件3件以上＋結果3件以上の時だけ非nullを返す（散らかった表では発火しない）。
const PROJ_TECHCOL = /(使用言語|開発言語|^言語|ＯＳ|^OS|サーバ|データベース|^DB|フレームワーク|ミドル|ツール|機種|開発環境|環境・言語|環境\/言語|得意技術|利用技術|^技術$|技術・環境|環境等|ＤＢ|使用ＤＢ|使用DB|DB関連|FW\/Tool|FW\/ツール)/
const PROJ_PERIODCOL = /(期間|稼働)/
const KAKKO_TECH = /^(OS|ＯＳ|言語|開発言語|使用言語|DB|ＤＢ|データベース|FW|フレームワーク|ミドル|ミドルウェア|サーバ|MW)/
const KAKKO_SKIP = /^(役割|規模|担当|フェーズ|工程|人数|チーム|概要|プロジェクト|業務|実績|取り組|備考|ツール|その他|IDE|環境|機材|計測|画像処理)/
const PROJ_JUNK = /^(SDK|ver|version|v|IDE|pro|＋|拡張機能|既存コード解析|ライブラリ|エディタ|各種|他|その他|等|ＦＷ|Framework|フレームワーク|画像処理ライブラリ|計測器|開発ツール|開発環境|Server|Basic|Studio|Code|Cloud|on|Native)$/i
const PROJ_MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function projParsePeriod(text: string, nowMonth: number): { start: number | null; end: number | null; dur: number | null } {
  const v = text.replace(/\s/g, '')
  const nums: number[] = []
  let now = /現在|現時点|継続|至現在/.test(v)
  for (const m of v.matchAll(/(19|20)(\d{2})[年\/.\-](\d{1,2})/g)) nums.push((+`${m[1]}${m[2]}`) * 12 + +m[3])
  for (const m of v.matchAll(/(\d{2})年([A-Za-z]{3})/g)) { const mo = PROJ_MON[m[2].toLowerCase()]; if (mo) nums.push((2000 + +m[1]) * 12 + mo) }
  for (const m of v.matchAll(/\b(\d{2})[\/.](\d{1,2})\b/g)) { if (+m[1] <= 40) nums.push((2000 + +m[1]) * 12 + +m[2]) }
  let dur: number | null = null
  const dm = v.match(/(\d{1,2})年(\d{1,2})[ヶかカ]月|(\d{1,2})年(?!\d)|(\d{1,3})[ヶかカ]月/)
  if (dm) { const mo = dm[1] ? +dm[1] * 12 + +dm[2] : dm[3] ? +dm[3] * 12 : +dm[4]; if (mo >= 1 && mo <= 600) dur = mo }
  if (nums.length >= 2) return { start: Math.min(...nums), end: now ? nowMonth : Math.max(...nums), dur }
  if (nums.length === 1 && now) return { start: nums[0], end: nowMonth, dur }
  return { start: null, end: null, dur }
}
// 単一スペースで割ると壊れる複合スキル名（SQL Server, Visual Basic, PL/SQL 等）
const PROJ_KEEP_WHOLE = /(SQL\s*Server|Visual\s*Basic|Visual\s*Studio|Transact[- ]?SQL|PL\/?SQL|Ruby\s*on\s*Rails|Amazon\s*Web\s*Services|Google\s*Cloud|Windows\s*Server|Objective[- ]?C|Node\.?js|Power\s*Automate|Power\s*BI|Power\s*Query|\.NET\s*Core|ASP\.NET)/gi
function projSplitTokens(s: string): string[] {
  // 複合名を退避(KWH記号)→空白分割→復元。実バージョン番号(Windows2012等)と衝突しない
  const held: string[] = []
  s = s.replace(PROJ_KEEP_WHOLE, (m) => { held.push(m.replace(/\s+/g, ' ').trim()); return `KWH${held.length - 1}KWH` })
  const restore = (x: string) => x.replace(/KWH(\d+)KWH/g, (_, i) => held[+i] || '')
  return s.split(/[\/／、,\n\r・（(）)]|\s{2,}|　| /).map((x) => x.replace(/^[◆■●・\s]+/, '').trim())
    .map((x) => /KWH\d+KWH/.test(x) ? restore(x) : restore(x.replace(/[\s]*\d+(\.\d+)*[a-z]?$/i, '').replace(/等$|など$/, '').trim()))
    .filter((x) => x && x.length >= 2 && x.length <= 24 && !/^[-―ー~〜:：+＋]+$/.test(x) && !/^\d+$/.test(x)
      && !/(作成|開発|設計|テスト|実装|運用|保守|担当|業務|効率|改修|移行|対応|管理)$/.test(x) && !PROJ_JUNK.test(x))
}
const PROJ_PREFIX_RE = /(OS|ＯＳ|言語|開発言語|使用言語|DB|ＤＢ|データベース|FW|フレームワーク|ミドル|ミドルウェア|サーバ|MW|役割|規模|担当|工程|人数|チーム)[-－:：]/g
function projParseKakko(text: string): string[] {
  const out: string[] = []
  // ① 【カテゴリ】値 形式
  const parts = text.split(/【([^】]*)】/)
  if (parts.length > 1) {
    out.push(...projSplitTokens(parts[0])) // 最初の【】より前の平文もtechとして拾う(隣の説明セルが横に混入する型)
    for (let i = 1; i < parts.length; i += 2) {
      const cat = parts[i].trim(); const val = parts[i + 1] || ''
      if (KAKKO_SKIP.test(cat)) continue
      if (KAKKO_TECH.test(cat)) out.push(...projSplitTokens(val))
    }
    return out
  }
  // ② 「言語-…」「OS-…」「DB-MySQL」等の接頭辞形式（ハイフン/コロン区切り）
  const markers = [...text.matchAll(PROJ_PREFIX_RE)]
  if (markers.length > 0) {
    for (let i = 0; i < markers.length; i++) {
      const cat = markers[i][1]
      const s = markers[i].index! + markers[i][0].length
      const e = i + 1 < markers.length ? markers[i + 1].index! : text.length
      if (KAKKO_SKIP.test(cat)) continue
      if (KAKKO_TECH.test(cat)) out.push(...projSplitTokens(text.slice(s, e)))
    }
    return out
  }
  // ③ 接頭辞なし→そのまま分割
  return projSplitTokens(text)
}
function projMergeMonths(iv: [number, number][]): number {
  if (!iv.length) return 0
  const s = iv.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0])
  if (!s.length) return 0
  let t = 0, cs = s[0][0], ce = s[0][1]
  for (let i = 1; i < s.length; i++) { const [a, b] = s[i]; if (a <= ce + 1) { if (b > ce) ce = b } else { t += ce - cs + 1; cs = a; ce = b } }
  return t + ce - cs + 1
}
function extractSkillYearsVisualProject(cells: SpanCell[], deadline = 0): Record<string, number> | null {
  if (deadline && Date.now() > deadline) return null
  const nowMonth = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
  const byRow: Record<number, SpanCell[]> = {}
  for (const c of cells) if (c.value.trim()) (byRow[c.row] ??= []).push(c)
  const rows = Object.keys(byRow).map(Number).sort((a, b) => a - b)
  // 各行が日付セルを含むか（案件表ヘッダーは「下に日付データが続く」ことで判別。PR/要約欄の
  // 単発tech語の誤選択を防ぐ）
  const PROJ_ABS = /(19|20)\d{2}\s*[\/年.\-]\s*\d{1,2}|\d{2}[\/.]\d{1,2}|(\d{2})年[A-Za-z]{3}|平成|令和|昭和/
  const dateRow: Record<number, boolean> = {}
  for (const r of rows) dateRow[r] = byRow[r].some((c) => PROJ_ABS.test(c.value.replace(/\s/g, '')))
  // ヘッダー検出: tech列見出し数＋期間見出し＋直下に日付行が続くかで加点
  let hdr = -1, best = -1, tcols: number[] = [], pcols: number[] = []
  for (const r of rows) {
    const tc: number[] = [], pc: number[] = []
    // 見出しは字間スペースを除去してから照合（"O S"→"OS"、"期 間"→"期間"）。長い結合見出し
    // （"開発環境（OS／言語…）"等）も30字までは substring で拾う。
    for (const c of byRow[r]) { const v = c.value.replace(/\s/g, '').trim(); if (v.length <= 30 && PROJ_TECHCOL.test(v)) tc.push(c.col); if (v.length <= 10 && PROJ_PERIODCOL.test(v)) pc.push(c.col) }
    for (const c of byRow[r]) { if (/【\s*(OS|ＯＳ|言語|DB|ＤＢ)/.test(c.value) && !tc.includes(c.col)) tc.push(c.col) }
    if (tc.length === 0) continue
    const below = rows.filter((x) => x > r && x <= r + 30 && dateRow[x]).length
    // tech列数を強めに重み付け（2行ヘッダーで「期間/開発環境」の粗い行より、ＯＳ/ＤＢ/言語と
    // 細かく分かれた行=本物の列見出しを優先）
    const score = tc.length * 3 + (pc.length ? 3 : 0) + (below >= 2 ? 10 : 0) + Math.min(below, 5)
    if (score > best) { best = score; hdr = r; tcols = [...new Set(tc)]; pcols = pc }
  }
  if (hdr < 0 || tcols.length < 2) return null // 信頼ゲート①: tech列2本以上
  // 案件ブロック化: tech列の結合セル ＋「結合セル(rowspan2〜20)を持つ任意の列」を案件境界に使う。
  // No列や内容列が縦結合で案件を定義する表(No毎に1案件・c0=Noがrowspanで全行を覆う型)でも、
  // 結合されていない tech(言語/DB)をその案件範囲に正しく束ねられる。span>20の巨大結合は除外。
  const blocks: { r0: number; r1: number }[] = []
  for (const c of cells) {
    if (c.row <= hdr || !c.value.trim()) continue
    const span = c.rowEnd - c.row + 1
    if (tcols.includes(c.col) || (span >= 2 && span <= 20)) blocks.push({ r0: c.row, r1: c.rowEnd })
  }
  blocks.sort((a, b) => a.r0 - b.r0)
  const merged: { r0: number; r1: number }[] = []
  for (const b of blocks) { const last = merged[merged.length - 1]; if (last && b.r0 <= last.r1) last.r1 = Math.max(last.r1, b.r1); else merged.push({ ...b }) }
  if (merged.length < 3) return null // 信頼ゲート②: 案件3件以上
  const minTech = Math.min(...tcols)
  const colv = (r0: number, r1: number, col: number) => cells.filter((c) => c.col <= col && c.colEnd >= col && c.row >= r0 && c.row <= r1).map((c) => c.value).join(' \n ')
  const skillIv: Record<string, [number, number][]> = {}, skillFloat: Record<string, number> = {}
  for (const b of merged) {
    // 期間はブロック内の「tech列でない全セル」から抽出（期間列はtech列の左右どちらにもあり得る。
    // projParsePeriodが日付/期間だけ拾い他テキストは無視するため、位置を限定しない）
    const perText = cells.filter((c) => c.row >= b.r0 && c.row <= b.r1 && !tcols.some((tc) => c.col <= tc && c.colEnd >= tc)).map((c) => c.value).join(' ')
    const { start, end, dur } = projParsePeriod(perText, nowMonth)
    const techs = new Set<string>()
    for (const tc of tcols) for (const t of projParseKakko(colv(b.r0, b.r1, tc))) techs.add(t)
    if (techs.size === 0) continue
    if (start !== null && end !== null && end >= start && end - start <= 600) { for (const t of techs) (skillIv[t] ??= []).push([start, end]) }
    else if (dur !== null) { for (const t of techs) skillFloat[t] = (skillFloat[t] ?? 0) + dur }
  }
  const res: Record<string, number> = {}
  for (const sk of new Set([...Object.keys(skillIv), ...Object.keys(skillFloat)])) res[sk] = projMergeMonths(skillIv[sk] ?? []) + (skillFloat[sk] ?? 0)
  return Object.keys(res).length >= 3 ? res : null // 信頼ゲート③: 結果3件以上
}


const _cs = (c: SpanCell) => c.colEnd - c.col + 1   // colSpan
const _rs = (c: SpanCell) => c.rowEnd - c.row + 1   // rowSpan


/** セルから次の走査座標を取得。null なら初期値 (0,0)、KEY_H なら右へ、KEY_V なら下へ */
function getNextCoord(cell: SpanCell | null, state: 'KEY_H' | 'KEY_V'): [number, number] {
  if (!cell) return [0, 0]
  if (state === 'KEY_H') return [cell.row, cell.colEnd + 1]
  return [cell.rowEnd + 1, cell.col]
}

/** START 状態のハンドラー */
function handleStart(
  cell: SpanCell | undefined,
  row: number,
  col: number,
  context: { smKey: SpanCell | null; currentRecord: Record<string, unknown>; recordStack: Record<string, unknown>[]; keyStack: SpanCell[]; inSkillDeepDive: boolean; visited: Set<SpanCell> },
  skillNameSet: Set<string>
): [Sm, [number, number], boolean] {
  // 見つかったセルが親コンテナからはみ出ているかチェック
  // はみ出ていたら親から独立させる。親の親からもはみ出ていたら更に独立させる。
  // これを繰り返す。
  if (cell) {
    while (context.keyStack.length > 0) {
      const parentContainer = context.keyStack[context.keyStack.length - 1]

      // はみ出しをチェック
      if (cell.col < parentContainer.col ||                                              // 左にはみ出し
          cell.row < parentContainer.row ||                                              // 上にはみ出し
          (parentContainer.colEnd < cell.col && parentContainer.rowEnd < cell.rowEnd) || // 横の子のはみ出し
          (parentContainer.rowEnd < cell.row && parentContainer.colEnd < cell.colEnd)) { // 縦の子のはみ出し
        // はみ出ている → 親から独立
        context.currentRecord = context.recordStack.pop()!
        context.keyStack.pop()
      } else {
        // はみ出ていない → 親内におさまっている
        break
      }
    }
  }

  if (!cell) {
    return [Sm.START, [row, col + 1], false]
  }
  const keyValue = cell.value.trim()
  context.smKey = cell
  context.currentRecord[keyValue] = undefined

  // inSkillDeepDive をセット: キー自体がスキル名（PHP, Java 等）のとき true
  // スキルがキー位置に来る場合（PHP | 3年）、右隣の TAG_DICT 語を兄弟キーとして扱うため
  context.inSkillDeepDive = skillNameSet.has(keyValue.toLowerCase().replace(/\s+/g, ''))

  return [Sm.KEY_H, getNextCoord(cell, 'KEY_H'), true]
}

/** KEY_H 状態のハンドラー */
function handleKeyH(
  cell: SpanCell | undefined,
  row: number,
  col: number,
  context: { smKey: SpanCell | null; currentRecord: Record<string, unknown>; recordStack: Record<string, unknown>[]; keyStack: SpanCell[]; inSkillDeepDive: boolean; visited: Set<SpanCell> },
  skillNameSet: Set<string>
): [Sm, [number, number], boolean] {
  const right = cell
  if (!right) {
    // キーバリュー成立: undefined を "" に変換
    const keyName = context.smKey!.value.trim()
    if (context.currentRecord[keyName] === undefined || context.currentRecord[keyName] === "") {
      context.currentRecord[keyName] = ""
    }
    return [Sm.KEY_H, [row, col + 1], false]
  }

  const key = context.smKey!
  const keyRS = _rs(key)
  const rightRS = _rs(right)
  const rightValue = right.value.trim()
  const keyValue = key.value.trim()

  // 完全なる親からのはみ出し判定
  while (context.keyStack.length > 0) {
    const parentContainer = context.keyStack[context.keyStack.length - 1]
    // はみ出しをチェック
    if (parentContainer.colEnd <= right.col && parentContainer.rowEnd <= right.row) {
      if (context.currentRecord[keyValue] === undefined) {
        // 兄弟キー → currentRecord に追加してから key のままで KEY_V へ
        return [Sm.KEY_V, getNextCoord(key, 'KEY_V'), false]
      } else {
        context.smKey = cell
        context.currentRecord[rightValue] = undefined

        // inSkillDeepDive をセット: キー自体がスキル名（PHP, Java 等）のとき true
        // スキルがキー位置に来る場合（PHP | 3年）、右隣の TAG_DICT 語を兄弟キーとして扱うため
        context.inSkillDeepDive = skillNameSet.has(rightValue.toLowerCase().replace(/\s+/g, ''))

        return [Sm.KEY_H, getNextCoord(cell, 'KEY_H'), true]
      }
    }
  }

  if (rightRS === keyRS) {
    const isStructureKey = STRUCTURE_KEY_DICT.test(rightValue)
    const isTagKey = TAG_DICT.test(rightValue)
    const shouldBeSibling = isStructureKey || (context.inSkillDeepDive && isTagKey)

    console.log(`[KEY_H] key="${keyValue}" right="${rightValue}" rs=${keyRS}==${rightRS} struct=${isStructureKey} tag=${isTagKey} skill=${context.inSkillDeepDive} -> sibling=${shouldBeSibling}`)

    if (shouldBeSibling) {
      if (context.currentRecord[keyValue] === undefined) {
        // 兄弟キー → currentRecord に追加してから key のままで KEY_V へ
        return [Sm.KEY_V, getNextCoord(key, 'KEY_V'), false]
      } else {
        context.smKey = cell
        context.currentRecord[rightValue] = undefined

        // inSkillDeepDive をセット: キー自体がスキル名（PHP, Java 等）のとき true
        // スキルがキー位置に来る場合（PHP | 3年）、右隣の TAG_DICT 語を兄弟キーとして扱うため
        context.inSkillDeepDive = skillNameSet.has(rightValue.toLowerCase().replace(/\s+/g, ''))

        return [Sm.KEY_H, getNextCoord(cell, 'KEY_H'), true]
      }
    }
  }

  if (rightRS > keyRS) {
    context.smKey = cell
    context.currentRecord[rightValue] = undefined

    // inSkillDeepDive をセット: キー自体がスキル名（PHP, Java 等）のとき true
    // スキルがキー位置に来る場合（PHP | 3年）、右隣の TAG_DICT 語を兄弟キーとして扱うため
    context.inSkillDeepDive = skillNameSet.has(rightValue.toLowerCase().replace(/\s+/g, ''))

    return [Sm.KEY_H, getNextCoord(cell, 'KEY_H'), true]
  }

  if (rightRS < keyRS) {
    if (TAG_DICT.test(rightValue)) {
      // コンテナ昇格: key の値を {} にし、その中に rightValue をキーとして追加
      const keyName = key.value.trim()
      const newContainer: Record<string, unknown> = {}
      context.currentRecord[keyName] = newContainer
      newContainer[rightValue] = ""
      context.recordStack.push(context.currentRecord)
      context.keyStack.push(key)  // 親キーセルを積む（rowEnd/colEnd で範囲判定）
      context.currentRecord = newContainer
      return [Sm.KEY_H, getNextCoord(key, 'KEY_H'), true]
    }
  }

  // 値確定前に親からのはみ出し判定
  while (context.keyStack.length > 0) {
    const parentContainer = context.keyStack[context.keyStack.length - 1]

    // はみ出しをチェック
    if (right.col < parentContainer.col ||                                               // 左にはみ出し
        right.row < parentContainer.row ||                                               // 上にはみ出し
        (parentContainer.colEnd < right.col && parentContainer.rowEnd < right.rowEnd) || // 横の子のはみ出し
        (parentContainer.rowEnd < right.row && right.colEnd < parentContainer.colEnd)) { // 縦の子のはみ出し
      // はみ出ている → 親から独立
      context.currentRecord = context.recordStack.pop()!
      context.keyStack.pop()
    } else {
      // はみ出ていない → 親内におさまっている
      break
    }
  }

  // 共通：値確定処理
  const keyName = key.value.trim()

  if (context.currentRecord[keyName] === undefined || context.currentRecord[keyName] === "") {
    // undefined から値に
    context.currentRecord[keyName] = rightValue
  } else if (Array.isArray(context.currentRecord[keyName])) {
    // すでに配列なら要素追加
    if (rightValue !== "") {
      (context.currentRecord[keyName] as unknown[]).push(rightValue)
    }
  } else {
    // 既存値があれば配列化
    if (rightValue !== "") {
      const existing = context.currentRecord[keyName]
      context.currentRecord[keyName] = [existing, rightValue]
    }
  }
  // 値確定後は さらなるバリューを求めてKEY_Hのまま次へ
  return [Sm.KEY_H, getNextCoord(key, 'KEY_H'), true]
}

/** KEY_V 状態のハンドラー */
function handleKeyV(
  cell: SpanCell | undefined,
  row: number,
  col: number,
  context: { smKey: SpanCell | null; currentRecord: Record<string, unknown>; recordStack: Record<string, unknown>[]; keyStack: SpanCell[]; inSkillDeepDive: boolean; visited: Set<SpanCell> },
  skillNameSet: Set<string>
): [Sm, [number, number], boolean] {
  const below = cell
  if (!below) {
    // 下セルなし → キーの値は空文字のまま確定、親に遡って兄弟キーを探す
    if (context.recordStack.length > 1) {
      context.currentRecord = context.recordStack.pop()!
      context.keyStack.pop()
      return [Sm.KEY_H, getNextCoord(context.smKey!, 'KEY_H'), false]
    }
    // 右セルなし → START へ
    const nextCoord = getNextCoord(context.smKey!, 'KEY_H')
    context.smKey = null
    return [Sm.START, nextCoord, false]
  }

  const key = context.smKey!
  const keyCS = _cs(key)
  const belowCS = _cs(below)
  const belowValue = below.value.trim()

  // 完全なる親からのはみ出し判定
  while (context.keyStack.length > 0) {
    const parentContainer = context.keyStack[context.keyStack.length - 1]
    // はみ出しをチェック
    if (parentContainer.colEnd <= below.col && parentContainer.rowEnd <= below.row) {
      const keyName = key.value.trim()
      if (context.currentRecord[keyName] === undefined) {
        // キーの値が未確定 → KEY_V で下へ進む（次の兄弟キーか値を探す）
        return [Sm.KEY_V, getNextCoord(key, 'KEY_V'), false]
      } else {
        // キーの値が既に確定 → 新しい兄弟キーを登録
        context.smKey = below
        context.currentRecord[belowValue] = ""
        // KEY_H へ → 右隣の値を取りに行く
        return [Sm.KEY_H, getNextCoord(below, 'KEY_H'), true]
      }
    }
  }

  // 兄弟キー: colSpan が同じかつ (STRUCTURE_KEY_DICT or (inSkillDeepDive && TAG_DICT))
  if (belowCS === keyCS && (STRUCTURE_KEY_DICT.test(belowValue) || (context.inSkillDeepDive && TAG_DICT.test(belowValue)))) {
    const keyName = key.value.trim()
    if (context.currentRecord[keyName] === undefined) {
      // キーの値が未確定 → KEY_V で下へ進む（次の兄弟キーか値を探す）
      return [Sm.KEY_V, getNextCoord(key, 'KEY_V'), false]
    } else {
      // キーの値が既に確定 → 新しい兄弟キーを登録
      context.smKey = below
      context.currentRecord[belowValue] = ""
      // KEY_H へ → 右隣の値を取りに行く
      return [Sm.KEY_H, getNextCoord(below, 'KEY_H'), true]
    }
  }

  // コンテナ昇格: TAG_DICT 一致かつ colSpan < key → 階層を下げる
  if (TAG_DICT.test(belowValue) && belowCS < keyCS) {
    const keyName = key.value.trim()
    const newContainer: Record<string, unknown> = {}
    context.currentRecord[keyName] = newContainer
    newContainer[belowValue] = ""
    context.recordStack.push(context.currentRecord)
    context.keyStack.push(key)  // 親キーセルを積む（rowEnd/colEnd で範囲判定）
    context.currentRecord = newContainer
    context.smKey = below
    return [Sm.KEY_H, getNextCoord(below, 'KEY_H'), true]
  }

  // 値確定前に親からのはみ出し判定
  while (context.keyStack.length > 0) {
    const parentContainer = context.keyStack[context.keyStack.length - 1]

    // はみ出しをチェック
    if (below.col < parentContainer.col ||                                               // 左にはみ出し
        below.row < parentContainer.row ||                                               // 上にはみ出し
        (parentContainer.colEnd < below.col && parentContainer.rowEnd < below.rowEnd) || // 横の子のはみ出し
        (parentContainer.rowEnd < below.row && parentContainer.colEnd < below.colEnd)) { // 縦の子のはみ出し
      // はみ出ている → 親から独立
      context.currentRecord = context.recordStack.pop()!
      context.keyStack.pop()
    } else {
      // はみ出ていない → 親内におさまっている
      break
    }
  }

  // 値確定
  const keyName = key.value.trim()
  if (context.currentRecord[keyName] === undefined || context.currentRecord[keyName] === "") {
    context.currentRecord[keyName] = belowValue
  } else if (Array.isArray(context.currentRecord[keyName])) {
    (context.currentRecord[keyName] as unknown[]).push(belowValue)
  } else {
    const existing = context.currentRecord[keyName]
    context.currentRecord[keyName] = [existing, belowValue]
  }
  return [Sm.KEY_V, getNextCoord(below, 'KEY_V'), true]
}


/** V1 processExcelWithStateMachine は テストスクリプト (test_excel_statemachine.mjs) に移動済み */

// ─── spanCellsToJson 用共有ヘルパー ─────────────────────────────────────────

/** container の座標内にある子セルを返す（container 自身は除く） */
function _childCells(all: SpanCell[], cont: SpanCell): SpanCell[] {
  // 通常ケース: rowSpan > 1 → rowEnd で範囲を確定。col は左端のみ判定
  if (cont.rowEnd > cont.row) {
    return all.filter(c =>
      c !== cont &&
      c.row >= cont.row && c.rowEnd <= cont.rowEnd &&
      c.col >= cont.col
    )
  }
  // rowSpan=1 ケース: col 範囲内にセルが存在しない行（空行）が来るまで下方向にスキャン
  const candidates = all.filter(c =>
    c !== cont &&
    c.row > cont.row &&
    c.col >= cont.col
  )
  if (candidates.length === 0) return []
  const rowsWithCells = new Set(candidates.map(c => c.row))
  let limitRow = cont.row
  for (let r = cont.row + 1; rowsWithCells.has(r); r++) limitRow = r
  return candidates.filter(c => c.row <= limitRow)
}

/** key の直下（rowEnd+1 の行、col 範囲内）の最初のセルを返す */
function _belowCell(sorted: SpanCell[], key: SpanCell): SpanCell | undefined {
  return sorted.find(c =>
    c.row === key.rowEnd + 1 && c.col >= key.col && c.col <= key.colEnd
  )
}

/** spanCellsToJson 内のステートマシン状態 */
const enum Sm { START = 0, KEY_H = 1, KEY_V = 2, END = 3 }

/**
 * CONTAINER: 子セルをステートマシンで再帰スキャンし、1つのオブジェクトに結合して返す。
 * 子が単一セルのみの場合はその value を直接返す。
 */
// deno-lint-ignore no-explicit-any
function _scanContainer(cells: SpanCell[], deadline = 0): Record<string, any> | string {
  if (cells.length === 1) return cells[0].value.trim()
  const rows = spanCellsToJson(cells, deadline)
  // deno-lint-ignore no-explicit-any
  const merged: Record<string, any> = {}
  for (const r of rows) Object.assign(merged, r)
  if (Object.keys(merged).length === 0 && cells.length > 0) {
    return cells[0].value.trim()
  }
  return merged
}

/**
 * SpanCell 配列をステートマシンで走査し JSON 行配列に変換する。
 *
 * 状態遷移: START → (KEY_H or KEY_V) → ... → END/新行へ
 *
 * 入力: cells (SpanCell[])
 * 出力: Array<Record<string, any>> (各行ごとの record を push)
 */
/**
 * deadline: Date.now() 基準の締切ミリ秒（0 = 無制限）。
 * _scanContainer 経由の再帰が結合セルの多い経歴書で組合せ爆発し、457セルのシートで
 * 1回のパースに30分以上かかる実害があった（本番Edgeではワーカー強制終了= メールsilent drop）。
 * 締切超過時はそこまでの結果を返して打ち切る（jsonRowsはHF品質チェック用の補助データであり、
 * テキスト抽出・skillYears grid抽出は別経路なので主要機能は影響を受けない）。
 */
// deno-lint-ignore no-explicit-any
function spanCellsToJson(cells: SpanCell[], deadline = 0): Array<Record<string, any>> {
  if (cells.length === 0) return []
  if (deadline > 0 && Date.now() > deadline) return []

  const sorted = [...cells].sort((a, b) =>
    a.row !== b.row ? a.row - b.row : a.col - b.col
  )
  const byRow = new Map<number, SpanCell[]>()
  for (const c of sorted) {
    if (!byRow.has(c.row)) byRow.set(c.row, [])
    byRow.get(c.row)!.push(c)
  }
  const rowNums = [...byRow.keys()].sort((a, b) => a - b)

  // deno-lint-ignore no-explicit-any
  const results: Array<Record<string, any>> = []

  for (const rowNum of rowNums) {
    if (deadline > 0 && Date.now() > deadline) break
    const rowCells = byRow.get(rowNum) ?? []
    if (rowCells.filter(c => c.value.trim()).length === 0) continue

    // deno-lint-ignore no-explicit-any
    const record: Record<string, any> = {}
    let smI = 0
    let smKey: SpanCell | null = null
    let sm = Sm.START
    let inSkillDeepDive = false

    // START: 次のキー候補を読む
    const smStart = (): Sm => {
      if (smI >= rowCells.length) return Sm.END

      smKey = rowCells[smI]
      const kv = smKey.value.trim()

      // inSkillDeepDive: TAG_DICT に一致するが STRUCTURE_KEY_DICT に一致しない → スキル深掘り語
      inSkillDeepDive = TAG_DICT.test(kv) && !STRUCTURE_KEY_DICT.test(kv)

      // インラインKV: キー候補セルに ： を含む → 値確定
      const ci = smKey.value.indexOf('：')
      if (ci > 0) {
        record[smKey.value.slice(0, ci).trim()] = smKey.value.slice(ci + 1).trim()
        smI++
        return Sm.START
      }

      // 右セルがあれば KEY_H、なければ KEY_V
      return rowCells[smI + 1] ? Sm.KEY_H : Sm.KEY_V
    }

    // KEY_H: 右セルを確認して判定
    const smKeyH = (): Sm => {
      const key = smKey!
      const right = rowCells[smI + 1]

      // 兄弟判定（rowSpan == key.rowSpan かつ STRUCTURE_KEY_DICT or (inSkillDeepDive && TAG_DICT)）→ KEY_V
      if (_rs(right) === _rs(key)) {
        if (STRUCTURE_KEY_DICT.test(right.value.trim())) return Sm.KEY_V
        if (inSkillDeepDive && TAG_DICT.test(right.value.trim())) return Sm.KEY_V
      }

      // コンテナ判定（TAG_DICT かつ rowSpan < key.rowSpan）→ 子ステートマシン実行
      if (TAG_DICT.test(right.value.trim()) && _rs(right) < _rs(key)) {
        const ch = _childCells(sorted, right)
        record[key.value.trim()] = _scanContainer(ch, deadline)
        smI += 2
        return Sm.START
      }

      // 値判定（rowSpan == key.rowSpan）→ 値確定 + 右方向継続チェック
      if (_rs(right) === _rs(key)) {
        let kvValue = right.value.trim()
        smI += 2
        // KV_DONE: 右方向の値継続をチェック
        const keyRS = _rs(key)
        let prevColEnd = right.colEnd
        while (smI < rowCells.length) {
          const next = rowCells[smI]
          const nv = next.value.trim()
          if (_rs(next) !== keyRS) break
          if (TAG_DICT.test(nv) || STRUCTURE_KEY_DICT.test(nv)) break
          // ギャップ検出
          if (prevColEnd >= 0 && next.col > prevColEnd + 1) break
          kvValue += nv
          prevColEnd = next.colEnd
          smI++
        }
        record[key.value.trim()] = kvValue
        return Sm.START
      }

      // KEY_V へ（rowSpan に差がある・その他の場合）
      return Sm.KEY_V
    }

    // KEY_V: 下セルを確認して判定
    const smKeyV = (): Sm => {
      const key = smKey!
      const below = _belowCell(sorted, key)

      // 下にセルなし → 次キーへ
      if (!below) {
        smI++
        return Sm.START
      }

      // 兄弟判定（colSpan == key.colSpan かつ TAG_DICT）→ KEY_V で次キー候補へ
      if (_cs(below) === _cs(key) && TAG_DICT.test(below.value.trim())) {
        smI++
        return Sm.START
      }

      // コンテナ判定（TAG_DICT かつ colSpan < key.colSpan）→ 子ステートマシン実行
      if (TAG_DICT.test(below.value.trim()) && _cs(below) < _cs(key)) {
        const ch = _childCells(sorted, key)
        record[key.value.trim()] = _scanContainer(ch, deadline)
        smI++
        return Sm.START
      }

      // 値判定（colSpan == key.colSpan の非タグ or その他）→ 値確定 + 下方向継続チェック
      if (_cs(below) === _cs(key) || _cs(below) > _cs(key)) {
        let kvValue = below.value.trim()
        smI++
        // KEY_V 値継続: 下方向チェック
        const keyCS = _cs(key)
        let prevRowEnd = below.rowEnd
        while (smI < rowCells.length) {
          const next = rowCells[smI]
          const nv = next.value.trim()
          if (_cs(next) !== keyCS) break
          if (TAG_DICT.test(nv)) break
          // ギャップ検出（行の連続性）
          if (prevRowEnd >= 0 && next.row > prevRowEnd + 1) break
          kvValue += nv
          prevRowEnd = next.rowEnd
          smI++
        }
        record[key.value.trim()] = kvValue
        return Sm.START
      }

      // デフォルト（colSpan < key.colSpan かつ非タグ）→ 複数値配列（値の縦継続）
      let kvValues: string[] = []
      kvValues.push(below.value.trim())
      smI++
      const keyCS = _cs(key)
      let scanRow = below.rowEnd + 1
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const candidates = sorted.filter(c =>
          c.row === scanRow && c.col >= key.col && c.colEnd <= key.colEnd
        ).sort((a, b) => a.col - b.col)
        if (candidates.length === 0) break
        if (TAG_DICT.test(candidates[0].value.trim())) break
        let spanSum = 0
        const rowVals: string[] = []
        for (const c of candidates) {
          if (TAG_DICT.test(c.value.trim())) break
          rowVals.push(c.value.trim())
          spanSum += _cs(c)
        }
        if (rowVals.length > 0) kvValues.push(...rowVals)
        if (spanSum < keyCS) break
        scanRow = candidates[candidates.length - 1].rowEnd + 1
      }
      record[key.value.trim()] = kvValues.length === 1 ? kvValues[0] : kvValues
      return Sm.START
    }

    while (sm !== Sm.END) {
      if (deadline > 0 && Date.now() > deadline) break
      switch (sm) {
        case Sm.START:  sm = smStart(); break
        case Sm.KEY_H:  sm = smKeyH(); break
        case Sm.KEY_V:  sm = smKeyV(); break
        default:             sm = Sm.END
      }
    }

    if (Object.keys(record).length > 0) results.push(record)
  }

  // NOTE: ここでの console.log は禁止。_scanContainer 経由で再帰呼び出しされるため、
  // 結合セルの多い経歴書（実例: 315KBのOH.xlsx）では1パースあたり数百万回実行され、
  // ログ出力だけで1リクエスト145秒かかる実害があった。ログは呼び出し元（extractExcelAll）で出す
  return results
}

/** JSON 行配列（列名ベース）からスキル別経験月数を抽出 */
// rows の型は Record<string,string>[]（sync_extractors の変換制約により any[] 注釈）
// deno-lint-ignore no-explicit-any
function extractSkillYearsFromSheetJson(rows: any[]): Record<string, number> {
  if (rows.length === 0) return {}
  const headers = Object.keys(rows[0])

  // 全角スペースを除去して列名を正規化（「言　語」→「言語」「O　S」→「OS」）
  const normalizeHeader = (h: string): string => h.replace(/[\s　]+/g, '').trim()

  // 列名パターン
  const PERIOD_COL  = /^(期間|プロジェクト期間|PJ期間|参画期間|在籍期間|作業期間|開始.{0,4}終了)$/
  const START_COL   = /^(開始|開始年月|FROM|開始日)$/i
  const END_COL     = /^(終了|終了年月|TO|終了日)$/i
  const DURATION_COL = /^(期間\(月\)|月数|期間月数|経験月数|在籍月数|作業月数|Months?)$/i
  const SKILL_COL   = /使用言語|使用技術|技術スタック|技術(?!力|的)|言語(?!\s*能)|FW|フレームワーク|ミドル|ツール|DB(?!A)|OS(?!\s*名)|インフラ|skill/i

  const periodCol   = headers.find(h => PERIOD_COL.test(normalizeHeader(h)))
  const startCol    = headers.find(h => START_COL.test(normalizeHeader(h)))
  const endCol      = headers.find(h => END_COL.test(normalizeHeader(h)))
  const durationCol = headers.find(h => DURATION_COL.test(normalizeHeader(h)))
  const skillCols   = headers.filter(h => SKILL_COL.test(normalizeHeader(h)))
  // 「期間」列が純整数値（月数）を持つかチェック（H.I 型: 「期間: 22」「期間: 6」等）。
  // ただし gridToJsonRows はヘッダー行に空セルがあると該当列を丸ごと落とすため、
  // 「期間」の隣に無題の日付列（開始/終了serial）がある表では、本来は行番号でしかない
  // 1,2,3…が「期間」列の値として残ってしまう。この行番号を月数と誤読すると、
  // 本当の日付が失われた上に桁違いに小さい月数を「確定値」として作ってしまい、
  // 件数（スキル数）で選ぶ勝者選択に間違って勝ってしまう実害があった（I.Sさん: Java 288→28ヶ月）。
  // 行順に厳密に 1,2,3,…,N と並ぶ（＝行番号そのもの）場合は月数として信頼しない
  const rawPeriodColName = headers.find(h => normalizeHeader(h) === '期間')
  // 1案件が複数行（データ行＋補足行）に渡る表では、値が入るのはデータ行だけで
  // 間に空文字の行を挟む（1, "", "", 2, "", "", 3, ...）。空文字は除外してから連番判定する
  const rawPeriodIntsAll = rawPeriodColName ? rows.map(r => {
    const v = String(r[rawPeriodColName] ?? '').trim()
    const n = parseInt(v, 10)
    return !isNaN(n) && n > 0 && n <= 600 && String(n) === v ? n : null
  }) : []
  // 「1から始まり、隣接値の差が0(マージセル展開による重複行)か1」なら行番号列とみなす。
  // 厳密な n===idx+1 判定だと、マージセルの重複展開（1,2,3,…,13,13,14,15）で外れてしまう
  const rawPeriodIntsNonNull = rawPeriodIntsAll.filter((n): n is number => n !== null)
  const looksLikeRowIndex = rawPeriodIntsNonNull.length >= 3
    && rawPeriodIntsNonNull[0] === 1
    && rawPeriodIntsNonNull.every((n, idx) => idx === 0 || (n - rawPeriodIntsNonNull[idx - 1] === 0 || n - rawPeriodIntsNonNull[idx - 1] === 1))
  const rawPeriodIsIntMonths = !looksLikeRowIndex && rawPeriodIntsAll.some(n => n !== null)

  if (skillCols.length === 0) return {}

  const skillMonths: Record<string, number> = {}
  const projectPeriods: Array<{ startYM: number; endYM: number }> = []
  const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1

  const parseYM = (s: string): number | null => {
    const m = s.match(/(\d{2,4})[\/\-年.](\d{1,2})/)
    if (m) {
      let year = parseInt(m[1])
      if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
      if (year >= 1970 && year <= 2100) return year * 12 + parseInt(m[2])
    }
    // US 日付形式 M/D/YY or M/D/YYYY
    const usm = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (usm) {
      const month = parseInt(usm[1])
      let year = parseInt(usm[3])
      if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
      if (month >= 1 && month <= 12 && year >= 1970 && year <= 2100) return year * 12 + month
    }
    return null
  }
  const resolveEndYM = (s: string): number | null => {
    if (/現在|今|present|継続|在籍中/i.test(s)) return nowYM
    return parseYM(s)
  }

  for (const row of rows) {
    let months: number | null = null
    let startYM: number | null = null
    let endYM: number | null = null

    // 優先1: 月数列（「作業月数」「月数」等の明示的な月数列）
    if (durationCol) months = parseDurationToMonths(row[durationCol] ?? '')
    // 優先1b: 「期間」列が純整数月数の場合
    if (!months && rawPeriodIsIntMonths && rawPeriodColName) {
      const v = String(row[rawPeriodColName] ?? '').trim()
      const n = parseInt(v, 10)
      if (!isNaN(n) && n > 0 && n <= 600 && String(n) === v) months = n
    }

    // 優先2: 期間列（"2020/04〜2023/03" 形式。「2026年2月〜2026年7月」「2026年2月1日〜
    // 2026年7月31日」のように開始側の年月（＋日）直後に「月」「日」が付く自然な表記
    // （区切り記号の前）にも対応する）
    if (!months && periodCol && row[periodCol]) {
      const ptext = row[periodCol]
      const m = ptext.match(/(\d{4}[\/年]\d{1,2})月?(?:\d{1,2}日)?\s*[〜～\-〜]\s*(\S+)/)
      if (m) {
        startYM = parseYM(m[1])
        endYM   = resolveEndYM(m[2])
        if (startYM && endYM) months = endYM - startYM + 1
      } else {
        months = parseDurationToMonths(ptext)
      }
    }

    // 優先3: 開始列 + 終了列
    if (!months && startCol && endCol && row[startCol] && row[endCol]) {
      startYM = parseYM(row[startCol])
      endYM   = resolveEndYM(row[endCol])
      if (startYM && endYM) months = endYM - startYM + 1
    }

    if (!months || months <= 0 || months > 600) continue
    if (startYM && endYM) projectPeriods.push({ startYM, endYM })

    // スキル抽出
    for (const col of skillCols) {
      const val = row[col] ?? ''
      const JSON_SKILL_BLOCKLIST = /^(自己PR|PR|備考|補足|資格|氏名|年齢|性別|国籍|住所|学歴|経歴|担当|役割|役職|ポジション|立場|評価|合計|スコア|レベル|プロジェクト名|企業名|規模|人数|期間|開始|終了|弊社社員|自社社員|社員|派遣|契約|フリー|なし|特になし|未経験|なし$)$/
      const skills = val.split(/[\n\r、，,\/・]+/).map(s => s.trim()).filter(s => s && s !== '-' && s !== '－' && s.length >= 2 && !/^\d+$/.test(s) && !JSON_SKILL_BLOCKLIST.test(s))
      for (const skill of skills) {
        skillMonths[skill] = (skillMonths[skill] ?? 0) + months
      }
    }
  }

  if (Object.keys(skillMonths).length === 0) return {}

  // _totalProjectMonths / _dateSpanMonths
  if (projectPeriods.length > 0) {
    skillMonths['_totalProjectMonths'] = projectPeriods.reduce((s, p) => s + (p.endYM - p.startYM + 1), 0)
    const allStarts = projectPeriods.map(p => p.startYM)
    const allEnds   = projectPeriods.map(p => p.endYM)
    const span = Math.max(...allEnds) - Math.min(...allStarts) + 1
    if (span > 0) skillMonths['_dateSpanMonths'] = span
  }
  return skillMonths
}

/**
 * skillYears 抽出結果から非スキルエントリを除去するフィルター。
 * 以下のようなエントリを除外する:
 *   - セクションヘッダーラベル（言語/FW, OS／MW, クラウド, ライブラリ 等）
 *   - 単価・金額表現（105万, 80万円 等）
 *   - 業務・工程語（概要, 今年度, 業務経験年数 等）
 *   - 過剰に長いキー（30文字超）
 * 内部メタキー（_ プレフィックス）はそのまま保持。
 */
function filterSkillYears(sy: Record<string, number>): Record<string, number> {
  // スキル名として不適切なヘッダーラベル・金額・業務語をフィルター
  // 例: 「言語／FW」「OS／MW」「概要」「105万」等
  const NON_SKILL_RE = /^(?:言語[/／・]?(?:FW|ツール|DB|技術|OS)?|OS[/／・]?M?W?|DB[/／・]?(?:DC|OS|MW)?|FW(?:[/／・]ツール)?|ライブラリ|クラウド(?:[/／・]NW)?|ツール(?:[/／・]技術)?|MW(?:[/／・]DB)?|NW(?:[/／・]クラウド)?|概要|今年度|業務経験(?:年数)?|業種|工程|フェーズ|役割|開発規模|使用言語|使用技術|技術スタック|開発環境|言語[・]FW|言語[/]技術|技術[/]環境)$/
  const MONEY_RE = /\d+万(?:円)?|円$/
  // 個人情報・履歴ラベルをスキル名として誤抽出しないためのブロックリスト
  const PERSONAL_INFO_RE = /^(学歴|最終学歴|氏名|ふりがな|フリガナ|生年月日|年齢|性別|住所|国籍|最寄[駅]?|電話|メール|資格|自己PR|PR|所属|経験年数|合計|総計|計|小計|期間合計|担当工程|在籍期間|参画期間|携わ)$/
  // 勤務形態・出社条件の語（名簿・条件欄から混入。「フルリモート=38年」「常駐可=27年」の実害）。
  // 「リモートデスクトップ」等の実スキルを守るため、リモートは末尾一致/併用形のみ
  const WORK_STYLE_RE = /リモート(?!デスクトップ)|常駐|出社|通勤|^在宅|応相談|^\d{2,3}-\d{2,3}$|以内$|以上$|時間まで$/
  // 勤務先の会社名・組織名（職歴欄から混入。「株式会社クロノス=31年」の実害）
  const COMPANY_NAME_RE = /株式会社|有限会社|合同会社|合資会社|事務所$|法人|財団|協会$|組合$|センター$|銀行$|信用金庫$/
  // 業務経歴テーブルの「工程」列見出し（要件定義/基本設計/...）・期間セクションのラベルは
  // スキル名ではなく、Excel添付テキストからの本文パターン誤マッチで拾われることがある
  const PHASE_LABEL_RE = /^(要件|定義|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|受入試験|運用保守|期間|稼働月数|担当範囲|体制|担当|作業内容|業務内容|担当業務|経験技術|作業概要|能力指標|能力判断|得意技術・?分野|得意分野|チーム|人数|全体|規模)$/
  // 日付・期間範囲がキーになっている場合を除外（例: "2022/2～2022/9", "2019年〜現在"）
  const DATE_RANGE_RE = /\d{4}[\/年]\d{1,2}/
  // キー自体が「8ヶ月」等の期間表記そのものになっている自己参照的な誤マッチを除外
  const SELF_DURATION_RE = /^\d+\s*[年ヶかカ]?[月]?$/
  // Excelの壊れた数式参照（削除されたセル・シートを指す数式が残っている場合）はスキル名として無効
  const FORMULA_ERROR_RE = /^#(?:REF!|VALUE!|NAME\?|DIV\/0!|N\/A|NULL!|NUM!)$/
  // 「【言語】」「【DB】」「【FW】」等、隅付き括弧で囲まれたセクション見出しはスキル名として無効
  // （経歴書の「担当業務」自由記述欄によくある環境見出しパターン）
  const BRACKET_HEADER_RE = /^【[^】]{1,10}】$/
  const result: Record<string, number> = {}
  for (const [k, v] of Object.entries(sy)) {
    if (k.startsWith('_')) { result[k] = v; continue }
    // 単一スキルの経験月数が40年(480ヶ月)を超えるのは非現実的。
    // 「工程」列見出しや期間セルの取り違えでブロック内の全ラベルに同じ
    // 巨大な月数が誤って割り当てられるケース（SQL:518ヶ月＝43年等）を弾く
    if (v > 480) continue
    if (k.length > 30) continue
    // 純粋な数字（行番号・案件番号等）はスキルとして無効
    if (/^\d+$/.test(k.trim())) continue
    const kNoSpace = k.replace(/[　 ]/g, '')
    if (NON_SKILL_RE.test(kNoSpace)) continue
    if (MONEY_RE.test(k)) continue
    if (PERSONAL_INFO_RE.test(kNoSpace)) continue
    if (PHASE_LABEL_RE.test(kNoSpace)) continue
    if (WORK_STYLE_RE.test(kNoSpace)) continue
    if (COMPANY_NAME_RE.test(kNoSpace)) continue
    // 「期間：」「能力指標　：」等のラベル残骸（末尾コロン）はスキル名ではない
    if (/[：:]\s*$/.test(kNoSpace)) continue
    // 半角カナのみ（ﾌﾘｶﾞﾅ等のフォームラベル）
    if (/^[ｦ-ﾟ]+$/.test(kNoSpace)) continue
    // 読点・句点を含む＝文章の断片（「運用・保守から参画し、…」等）
    if (/[、。]/.test(k)) continue
    // 読点で分割された後の文章断片: 助詞・接続で終わる／指示語で始まる
    // （「運用・保守から参画し」「その後移行」等。実スキル名はこの形にならない）
    if (/(し|して|した|する|から|まで|など)$/.test(kNoSpace)) continue
    if (/^(その|この|当該|同上)/.test(kNoSpace)) continue
    // ＜見出し＞形式のセクションラベル
    if (/^[＜<]|[＞>]$/.test(kNoSpace)) continue
    // 先頭が助詞の短いキー（「の名称」等、表のラベルが欠けた残骸）。
    // 「でんさいネット」等の実在語を守るため4文字以下に限定
    if (kNoSpace.length <= 4 && /^[のがをにへとで]/.test(kNoSpace)) continue
    if (SELF_DURATION_RE.test(k.trim())) continue
    if (DATE_RANGE_RE.test(k)) continue
    if (FORMULA_ERROR_RE.test(k.trim())) continue
    if (BRACKET_HEADER_RE.test(k.trim())) continue
    // 括弧の対応が崩れている断片（自由記述の途中で改行/スペース分割された残骸。
    // 例: "(Big" "Sur)" "(CentOS"）はスキル名として無効
    const openParens = (k.match(/[（(]/g) ?? []).length
    const closeParens = (k.match(/[）)]/g) ?? []).length
    if (openParens !== closeParens) continue
    result[k] = v
  }
  return result
}

/**
 * グリッド（2D 配列）からスキル別経験月数を統合抽出する。
 * Word・Excel 両形式に対応。3方式を試して最も取れた方を採用。
 *   方式1: 列名ベース（Excel スキル一覧型: 「経験年数」「使用言語」列を探す）
 *   方式2: 2D配列ベース（列名が読み取れない場合のフォールバック）
 *   方式3: テキストパターンベース（Word 型: 「スキル名 X年」パターン）
 *
 * @param grid  parseHtmlTableToGrid の出力
 * @param extraTexts Word の段落テキスト等、グリッド外のテキスト（省略可）
 */
function extractSkillYearsUnified(grid: string[][], extraTexts: string[] = []): Record<string, number> {
  // 方式1: 列名ベース
  const jsonRows = gridToJsonRows(grid)
  const sy1 = extractSkillYearsFromSheetJson(jsonRows)

  // 方式2: 2D配列ベース
  const sy2 = extractSkillYearsFromSheetData(grid)

  // 方式3: テキストパターンベース（「スキル名 X年」）
  const sy3: Record<string, number> = {}
  for (const text of [...grid.flat(), ...extraTexts]) {
    for (const seg of text.split(/[,、，\n]/)) {
      const m = seg.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)年(?:[^\d]|$)/)
      if (!m) continue
      let skill = m[1].trim()
      const colonIdx = Math.max(skill.lastIndexOf(':'), skill.lastIndexOf('：'))
      if (colonIdx >= 0) skill = skill.slice(colonIdx + 1).trim()
      const years = parseFloat(m[2])
      if (skill && years > 0 && years <= 50 && !/^\d/.test(skill)) {
        sy3[skill] = Math.round(years * 12)
      }
    }
  }

  // 方式4: Word 職務経歴書型（YYYY年MM月~約N年間 + [OS]/[言語]/[DB] パターン）
  const sy4: Record<string, number> = {}
  {
    let curMonths = 0
    const parseWordPeriod = (line: string): number => {
      // 約N年Mか月 / 約N年Mヶ月間 / 約N年間
      const m1 = line.match(/約(\d+)年(?:(\d+)[ヵヶか]ヶ?月)?間?/)
      if (m1) return parseInt(m1[1]) * 12 + parseInt(m1[2] || '0')
      if (/約半年/.test(line)) return 6
      // 約N年Mか月（間なし）
      const m2 = line.match(/約(\d+)年(\d+)か月/)
      if (m2) return parseInt(m2[1]) * 12 + parseInt(m2[2])
      // YYYY年MM月~YYYY年MM月
      const m3 = line.match(/(\d{4})年(\d{1,2})月[〜~～\-]+(\d{4})年(\d{1,2})月/)
      if (m3) {
        const sYM = parseInt(m3[1]) * 12 + parseInt(m3[2])
        const eYM = parseInt(m3[3]) * 12 + parseInt(m3[4])
        return Math.max(0, eYM - sYM + 1)
      }
      // YYYY年MM月~現在
      const m4 = line.match(/(\d{4})年(\d{1,2})月[〜~～\-]+現在/)
      if (m4) {
        const sYM = parseInt(m4[1]) * 12 + parseInt(m4[2])
        const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1
        return Math.max(0, nowYM - sYM + 1)
      }
      return 0
    }
    const SKIP_RE = /^(なし|[-－ー]|特記|注|備考)\s*[：:]?$/
    const TECH_LBL_RE = /^(OS|DB|言語|ミドルウェア|その他|ツール|クラウド|フレームワーク|FW|MW|サーバ)/i
    const extractFromSkillLine = (line: string) => {
      const markerRE = /[\[【]([^\]】]{1,20})[\]】]\s*([^\[【]*)/g
      let mm: RegExpExecArray | null
      while ((mm = markerRE.exec(line)) !== null) {
        const label = mm[1].trim()
        const content = mm[2].replace(/全\d+名.*$/, '').trim()
        if (!TECH_LBL_RE.test(label)) continue
        for (const raw of content.split(/[,、，]+/).map(s => s.trim())) {
          const skill = raw.trim()
          if (!skill || skill.length < 2 || SKIP_RE.test(skill)) continue
          if (/^(特記|注|備考)\s*[：:]/.test(skill)) continue
          if (/^\d+$/.test(skill)) continue // 純粋な数字はOSバージョンなので除外
          sy4[skill] = (sy4[skill] ?? 0) + curMonths
        }
      }
    }
    for (const para of extraTexts) {
      const months = parseWordPeriod(para)
      if (months > 0) { curMonths = months; continue }
      if (curMonths > 0 && (para.includes('[') || para.includes('【'))) {
        extractFromSkillLine(para)
      }
    }
  }

  // 方式5: キャリアシート型（「スキル名 [N] 年 [M] ヶ月」が1行に複数並ぶ形式）
  // 例: "Win 28 年 2 ヶ月 Java 16 年 4 ヶ月 Oracle 16 年 2 ヶ月"（各トークンが別セル）
  const sy5: Record<string, number> = {}
  {
    // ヘッダー行に「OS」「経験年数」「言語」が並ぶキャリアシートのみ対象
    const isCareerSheet = grid.slice(0, 30).some(row => {
      const joined = row.join('\t')
      return /OS.*経験年数.*言語|経験年数.*言語.*経験年数|技術.*経験.*OS.*言語/i.test(joined)
    })
    if (isCareerSheet) {
      // 業務スキル・業種名は除外（技術スキルのみ抽出）
      const BIZ_SKILL_RE = /^(金融|流通|公共|官公庁|人事|給与|医療|保険|製造|販売|管理|保守|業務|マイグレ|マイグレーション|小売|通信|社会保険|不動産|電力|自治体)/
      for (const row of grid) {
        // 連続トークンとして「[スキル名] [N] 年 [M?] ヶ月」を全検索
        // 年・月が別セルで存在するため、行全体をスペース結合してスキャン
        const line = row.join(' ')
        const re = /([^\s\d年ヶ月][^\s]{0,19})\s+(\d+)\s+年(?:\s+(\d+)\s+ヶ月|\s+ヶ月)?/g
        let mm: RegExpExecArray | null
        while ((mm = re.exec(line)) !== null) {
          const skill = mm[1].trim()
          const years = parseInt(mm[2])
          const months = parseInt(mm[3] ?? '0')
          const totalMonths = years * 12 + months
          if (!skill || years <= 0 || years > 50) continue
          if (/^\d/.test(skill) || BIZ_SKILL_RE.test(skill)) continue
          sy5[skill] = Math.max(sy5[skill] ?? 0, totalMonths)
        }
      }
    }
  }

  // 方式6: 能力評価型（◎/○/△/☆形式のスキルシート）
  // 例: "VBA ... 〇" → 12ヶ月（実務経験1年以上）、"事務 ... ◎" → 36ヶ月（3年以上）
  const sy6: Record<string, number> = {}
  {
    const RATING_MARKS: Record<string, number> = { '◎': 36, '○': 12, '〇': 12, '△': 6, '▲': 6 }
    const RATING_RE = /^[◎○〇△▲]$/
    // ヘッダー行に「能力」が3回以上ある行 = 能力評価型スキルシート
    const isRatingSheet = grid.some(row => row.filter(c => c === '能力').length >= 3)
    if (isRatingSheet) {
      const SKIP_CELLS = new Set(['能力', 'スキル', 'その他', '業務', '環境', '言語', 'ライブラリ', 'アピールポイント', '経歴', '資格', 'OS', 'DB', 'フリガナ', '氏名', '最寄駅', '最終学歴'])
      for (const row of grid) {
        for (let i = 0; i < row.length - 1; i++) {
          const cell = row[i].trim()
          if (!cell || RATING_RE.test(cell)) continue
          if (cell.length > 25) continue
          if (SKIP_CELLS.has(cell)) continue
          if (/^[【≪\d（(]/.test(cell)) continue
          // 後続セルにレーティングがある（途中は空白セルのみ）
          for (let j = i + 1; j <= Math.min(i + 14, row.length - 1); j++) {
            const nc = row[j].trim()
            if (!nc) continue
            if (RATING_RE.test(nc)) {
              const months = RATING_MARKS[nc]
              if (months) sy6[cell] = Math.max(sy6[cell] ?? 0, months)
              break
            } else {
              break // 空白以外の非レーティングセル → 別ペアの開始
            }
          }
        }
      }
    }
  }

  // 方式7: 文章行の期間×技術語（narrative Word: 「2007年6月〜2009年7月（…）…Javaで開発」）。
  // 期間範囲を含む行が3行以上あるときだけ発動（誤爆防止）。技術語はASCII連続列、期間は行内の範囲
  const sy7: Record<string, number> = {}
  {
    const RANGE7 = /((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月|(?:19|20)\d{2}[\/.]\d{1,2})\s*[〜～~\-－]\s*(現在|継続中?|(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月|(?:19|20)\d{2}[\/.]\d{1,2})/
    const ROLE7 = /^(PM|PL|PG|SE|PO|PMO|QA|TL|IT|OA|AI|IoT|FX|EC|BtoB|BtoC|SNS|No|OK|NG|ERP)$/i
    const nowY7 = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
    const iv7: Record<string, number[][]> = {}
    let rangeLines = 0
    for (const line of [...grid.flat(), ...extraTexts]) {
      const s = String(line)
      if (s.length < 12 || s.length > 2000) continue
      const mm = s.match(RANGE7)
      if (!mm) continue
      const a = parseYMParts(mm[1])
      const z = /現在|継続/.test(mm[2]) ? { year: Math.floor((nowY7 - 1) / 12), month: ((nowY7 - 1) % 12) + 1 } : parseYMParts(mm[2])
      if (!a || !z) continue
      const aa = a.year * 12 + a.month
      const zz = z.year * 12 + z.month
      if (zz < aa || zz - aa > 600) continue
      rangeLines++
      for (const mt of s.matchAll(/[A-Za-z][A-Za-z0-9+.#-]{1,24}/g)) {
        if (ROLE7.test(mt[0])) continue
        if (!iv7[mt[0]]) iv7[mt[0]] = []
        iv7[mt[0]].push([aa, zz])
      }
    }
    if (rangeLines >= 3) {
      for (const k of Object.keys(iv7)) sy7[k] = unionIntervalMonths(iv7[k])
    }
  }

  // 勝者選択（2026-07-20変更）: 「件数の多い方式」→「フィルタ後の品質スコアが最高の方式」。
  // 旧実装は (a)ゴミを多く出す方式が正確な方式に勝てる (b)方式2だけフィルタ後件数・他はフィルタ前
  // という不公平があった。全方式をフィルタしてから skill_master 照合の重み付きスコアで比較する
  // 起動時プリフェッチ済みキャッシュ（null時はスコア=件数に退化）。
  // typeof 判定は sync_extractors で切り出したローカルテスト実行時（モジュール変数なし）への配慮
  const masterSet = typeof _skillNameSet === 'undefined' ? null : _skillNameSet
  const candidates: Array<{ sy: Record<string, number>; method: string }> = [
    { sy: sy1, method: 'column' },
    { sy: sy2, method: 'array' },
    { sy: sy5, method: 'career-sheet' },
    { sy: sy6, method: 'rating' },
    { sy: sy4, method: 'word-narrative' },
    { sy: sy7, method: 'narrative-range' },
    { sy: sy3, method: 'text' },
  ]
  let best: Record<string, number> = {}
  let bestMethod = 'none'
  let bestScore = 0
  for (const c of candidates) {
    const filtered = filterSkillYears(c.sy)
    const score = scoreSkillQuality(filtered, masterSet)
    // 同点は先勝ち（配列順=従来の優先順位を維持）
    if (score > bestScore) { best = filtered; bestMethod = c.method; bestScore = score }
  }

  if (bestMethod !== 'none') {
    const count = Object.keys(best).filter(k => !k.startsWith('_')).length
    console.log(`[skillYears-unified] method=${bestMethod} count=${count} score=${bestScore}${masterSet ? '' : ' (master未取得=件数退化)'}`)
  }
  // 経路の永続記録（_extractMethod → raw_profile / pipeline_trace の B-SY-METHOD）。
  // 方式2(array)=extractSkillYearsFromSheetData は内部でより細かい番号
  // （10=列型 15=項番 16=複数年数列 17=KVブロック 20=近接探索 30=数値一覧）を設定済みのため上書きしない
  const DISPATCH_CODE: Record<string, number> = { column: 41, text: 43, 'word-narrative': 44, 'career-sheet': 45, rating: 46, 'narrative-range': 47 }
  if (bestMethod !== 'none' && best['_extractMethod'] === undefined && DISPATCH_CODE[bestMethod] !== undefined) {
    best['_extractMethod'] = DISPATCH_CODE[bestMethod]
  }
  return filterSkillYears(best)
}

/**
 * R.O 型: 「期間」ヘッダーが同一列に複数回繰り返す形式。
 * 各プロジェクトが独自の「期間」ヘッダーを持ち、隣列にプロジェクト番号/☆ マーカーが並ぶ。
 * スキルは「【言語】\n...\n【OS】\n...」形式のセルに格納される。
 */
function extractSkillYearsRepeatPeriodHeader(sorted: SpanCell[], periodHeaders: SpanCell[]): Record<string, number> {
  const maxRow = Math.max(...sorted.map(c => c.rowEnd))
  const skillMonths: Record<string, number> = {}
  let totalProjectMonths = 0
  const projectPeriods: Array<{ startYM: number; endYM: number }> = []
  const SERIAL_MIN = 25569
  const SERIAL_MAX = 48000
  const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1

  const parseSerial = (s: string): number | null => {
    const num = parseFloat(s)
    if (!isNaN(num) && num >= SERIAL_MIN && num <= SERIAL_MAX) {
      const d = new Date(Date.UTC(1899, 11, 30) + num * 86400000)
      return d.getUTCFullYear() * 12 + d.getUTCMonth() + 1
    }
    // SheetJS が Excel シリアル日付を M/D/YY 形式でフォーマットする場合に対応
    const mdyM = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (mdyM) {
      let y = parseInt(mdyM[3])
      if (y < 100) y = y < 50 ? 2000 + y : 1900 + y
      const mo = parseInt(mdyM[1])
      if (mo >= 1 && mo <= 12 && y >= 1990 && y <= 2040) return y * 12 + mo
    }
    const m = s.match(/(\d{2,4})[\/\-年](\d{1,2})/)
    if (m) {
      let year = parseInt(m[1])
      if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
      return year * 12 + parseInt(m[2])
    }
    return null
  }

  for (let i = 0; i < periodHeaders.length; i++) {
    const ph = periodHeaders[i]
    const blockStart = ph.row
    const blockEnd = i + 1 < periodHeaders.length ? periodHeaders[i + 1].row - 1 : maxRow
    const blockCells = sorted.filter(c => c.row >= blockStart && c.rowEnd <= blockEnd)

    // 期間の抽出
    let months: number | null = null
    let startYM: number | null = null
    let endYM: number | null = null

    // ① 明示的な "X年Yヶ月" / "Xヶ月"
    for (const bc of blockCells) {
      const v = bc.value.trim()
      const dm = v.match(/(\d+)年(\d+)[ヵヶか]月/)
      if (dm) { months = parseInt(dm[1]) * 12 + parseInt(dm[2]); break }
      const mm = v.match(/^(\d+)[ヵヶか]月$/)
      if (mm) { months = parseInt(mm[1]); break }
    }
    // ② シリアル日付（SheetJS が M/D/YY にフォーマットした日付も対象）
    if (!months) {
      const dateCells = blockCells.filter(c => {
        const v = c.value.trim()
        const num = parseFloat(v)
        if (!isNaN(num) && num >= SERIAL_MIN && num <= SERIAL_MAX) return true
        // SheetJS M/D/YY 形式: "10/1/25" = Oct 2025
        const mdyM = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
        if (mdyM) {
          const y = parseInt(mdyM[3]) < 100 ? (parseInt(mdyM[3]) < 50 ? 2000 + parseInt(mdyM[3]) : 1900 + parseInt(mdyM[3])) : parseInt(mdyM[3])
          return y >= 1990 && y <= 2040
        }
        return false
      })
      const presentCell = blockCells.find(c => /^(現在|今|継続|在籍中)$/i.test(c.value.trim()))
      if (dateCells.length >= 2) {
        const yms = dateCells.map(c => parseSerial(c.value.trim())).filter((v): v is number => v !== null)
        if (yms.length >= 2) { startYM = Math.min(...yms); endYM = Math.max(...yms); months = endYM - startYM + 1 }
      } else if (dateCells.length === 1 && presentCell) {
        startYM = parseSerial(dateCells[0].value.trim())
        if (startYM) { endYM = nowYM; months = nowYM - startYM + 1 }
      }
    }

    if (!months || months <= 0 || months > 600) continue
    totalProjectMonths += months
    if (startYM && endYM) projectPeriods.push({ startYM, endYM })

    // スキルの抽出: 「【言語】\n...\n【OS】\n...」形式
    const ENV_LBL_RE = /^【(言語|OS|FW|フレームワーク|ツール|DB|データベース|ミドルウェア|クラウド|インフラ|その他|NW)】/
    for (const bc of blockCells) {
      if (!bc.value.includes('【')) continue
      const lines = bc.value.split(/\r?\n/).map(l => l.replace(/^[　\s・]+/, '').trim()).filter(l => l)
      let inSection = false
      for (const line of lines) {
        if (ENV_LBL_RE.test(line)) { inSection = true; continue }
        if (/^【/.test(line)) { inSection = false; continue }
        if (!inSection || line === '-' || line === '－' || line.length < 2) continue
        for (const skill of line.split(/[、，,\/]+/).map(s => s.trim())) {
          if (skill && skill.length >= 2 && skill !== '-' && !/^\d+$/.test(skill)) {
            skillMonths[skill] = (skillMonths[skill] ?? 0) + months
          }
        }
      }
    }
  }

  if (Object.keys(skillMonths).length === 0) return {}
  if (totalProjectMonths > 0) skillMonths['_totalProjectMonths'] = totalProjectMonths
  if (projectPeriods.length > 0) {
    const span = Math.max(...projectPeriods.map(p => p.endYM)) - Math.min(...projectPeriods.map(p => p.startYM)) + 1
    if (span > 0) skillMonths['_dateSpanMonths'] = span
  }
  console.log(`[skillYears-repeat-period] projects=${periodHeaders.length} skills=${Object.keys(skillMonths).filter(k => !k.startsWith('_')).length}`)
  return skillMonths
}

/**
 * 期間ヘッダー型（M.A / Y.Y / M.T / M.H 型）:
 * 「No.」「項番」も丸数字もないが、「期間」ヘッダーの下に数字(1,2,3...)が並ぶ
 * 日本ITスキルシートの一般的なフォーマット。
 * - Col 0: 数字（プロジェクト番号、複数行をまたぐ結合セルのこともある）
 * - Col 1: 開始日シリアル / Col 3: 終了日シリアル or 「現在」
 * - 別行に "X年Yヶ月" / "Xヶ月" が入ることも多い
 * - スキル列: 「使用言語」「DB」「サーバOS」「ミドルウェア」「FW・MW」等
 */
function extractSkillYearsPeriodHeader(sorted: SpanCell[]): Record<string, number> {
  const periodHeader = sorted.find(c => /^期間$/.test(c.value.trim()))
  if (!periodHeader) return {}

  // 同列(c.col === periodHeader.col)の下に数字(1,2,3...)があるか確認
  const periodCol = periodHeader.col

  // R.O 型: 同じ列に「期間」ヘッダーが複数回繰り返す（各プロジェクトが独自ヘッダーを持つ）
  const allPeriodHeaders = sorted.filter(c =>
    /^期間$/.test(c.value.trim()) && c.col === periodCol
  ).sort((a, b) => a.row - b.row)
  if (allPeriodHeaders.length >= 2) {
    return extractSkillYearsRepeatPeriodHeader(sorted, allPeriodHeaders)
  }

  const numberCells = sorted.filter(c =>
    c.col === periodCol && c.row > periodHeader.rowEnd && /^\d+$/.test(c.value.trim())
  ).sort((a, b) => a.row - b.row)
  if (numberCells.length === 0) return {}

  // ヘッダー行からスキル列を特定
  const headerRowCells = sorted.filter(c =>
    c.row >= periodHeader.row && c.row <= periodHeader.rowEnd + 1
  )
  const SKILL_HDR_RE = /^(使用言語|言語|DB|ＤＢ|サーバ[ーー]?OS|OS等?|ミドルウェア|NW機器|ツール(他|類)?|FW[・\/]MW|パッケージ|クラウド|環境|フレームワーク|技術スタック|使用技術|機種[・]?OS)/i
  const skillHeaderCells = headerRowCells.filter(c => {
    const v = c.value.trim().replace(/[\r\n]+/g, ' ')
    const vn = v.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    return SKILL_HDR_RE.test(vn)
  })
  if (skillHeaderCells.length === 0) return {}

  // 「期間」列のヘッダー位置（OMT型: 小数値が入る "期間" 列）
  const durationHeaderCell = headerRowCells.find(c =>
    /^期間$/.test(c.value.trim()) && c !== periodHeader
  )

  const skillMonths: Record<string, number> = {}
  const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1
  const maxRow = Math.max(...sorted.map(c => c.rowEnd))
  let totalProjectMonths = 0
  const projectPeriods: Array<{ startYM: number; endYM: number }> = []

  const SERIAL_MIN = 25569 // 1970-01-01（古い案件対応）
  const SERIAL_MAX = 48000
  const parseSerial = (s: string): number | null => {
    const num = parseFloat(s)
    if (!isNaN(num) && num >= SERIAL_MIN && num <= SERIAL_MAX) {
      const d = new Date(Date.UTC(1899, 11, 30) + num * 86400000)
      return d.getUTCFullYear() * 12 + d.getUTCMonth() + 1
    }
    const m = s.match(/(\d{2,4})[\/\-年](\d{1,2})/)
    if (m) {
      let year = parseInt(m[1])
      if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
      return year * 12 + parseInt(m[2])
    }
    return null
  }

  for (let i = 0; i < numberCells.length; i++) {
    const nc = numberCells[i]
    const startRow = nc.row
    const endRow = nc.rowEnd > nc.row
      ? nc.rowEnd
      : (i + 1 < numberCells.length ? numberCells[i + 1].row - 1 : maxRow)
    const blockCells = sorted.filter(c => c.row >= startRow && c.rowEnd <= endRow)

    // ── 期間の抽出 ──
    let months: number | null = null
    let startYM: number | null = null
    let endYM: number | null = null

    // ① 明示的な "X年Yヶ月" / "Xヶ月" を優先
    for (const bc of blockCells) {
      const v = bc.value.trim()
      const dm = v.match(/(\d+)年(\d+)[ヵヶか]月/)
      if (dm) { months = parseInt(dm[1]) * 12 + parseInt(dm[2]); break }
      const mm = v.match(/^(\d+)[ヵヶか]月$/)
      if (mm) { months = parseInt(mm[1]); break }
    }

    // ② シリアル日付から計算
    if (!months) {
      const dateCells = blockCells.filter(c => {
        const num = parseFloat(c.value.trim())
        return !isNaN(num) && num >= SERIAL_MIN && num <= SERIAL_MAX
      })
      const presentCell = blockCells.find(c => /^(現在|今|継続|在籍中)$/i.test(c.value.trim()))
      if (dateCells.length >= 2) {
        const yms = dateCells.map(c => parseSerial(c.value.trim())).filter((v): v is number => v !== null)
        if (yms.length >= 2) {
          startYM = Math.min(...yms); endYM = Math.max(...yms)
          months = endYM - startYM + 1
        }
      } else if (dateCells.length === 1 && presentCell) {
        startYM = parseSerial(dateCells[0].value.trim())
        if (startYM) { endYM = nowYM; months = nowYM - startYM + 1 }
      }
    }

    // ③ 「期間」列の小数値（OMT型: "16.9856262" など）
    if (!months && durationHeaderCell) {
      const durCells = blockCells.filter(c =>
        c.col >= durationHeaderCell.col && c.col <= durationHeaderCell.colEnd
      )
      for (const dc of durCells) {
        const num = parseFloat(dc.value.trim())
        if (!isNaN(num) && num > 0 && num < 600) { months = Math.round(num); break }
      }
    }

    if (!months || months <= 0 || months > 600) continue
    totalProjectMonths += months
    if (startYM && endYM) projectPeriods.push({ startYM, endYM })

    // ── スキルの抽出 ──
    for (const hdr of skillHeaderCells) {
      const colCells = blockCells.filter(c =>
        c.col >= hdr.col && c.col <= hdr.colEnd
      )
      for (const cc of colCells) {
        const v = cc.value.trim()
        if (!v || v === '-' || v === '－' || v.length < 2) continue
        for (const line of v.split(/[\r\n]+/)) {
          let skill = line.trim()
          if (!skill || skill.length < 2 || skill === '-' || skill === '－') continue
          // 括弧不完全なフラグメント処理
          const op = (skill.match(/[（(]/g) || []).length
          const cl = (skill.match(/[）)]/g) || []).length
          if (op > cl) { skill = skill.replace(/[（(].*$/, '').trim(); if (!skill || skill.length < 2) continue }
          else if (cl > op) continue
          if (skill.length <= 50) {
            skillMonths[skill] = (skillMonths[skill] ?? 0) + months
          }
        }
      }
    }
  }

  if (Object.keys(skillMonths).length === 0) return {}

  if (totalProjectMonths > 0) skillMonths['_totalProjectMonths'] = totalProjectMonths
  if (projectPeriods.length > 0) {
    const allStarts = projectPeriods.map(p => p.startYM)
    const allEnds = projectPeriods.map(p => p.endYM)
    const span = Math.max(...allEnds) - Math.min(...allStarts) + 1
    if (span > 0) skillMonths['_dateSpanMonths'] = span
  }

  console.log(`[skillYears-period] projects=${numberCells.length} skills=${Object.keys(skillMonths).filter(k => !k.startsWith('_')).length}`)
  return skillMonths
}

/**
 * S.Y 型: 丸数字（①〜⑳）始まりセルをプロジェクト境界として経験月数を抽出するサブ関数。
 * - プロジェクト行: c1-4 に "⑫保険業..." など丸数字始まりのタイトル
 * - 期間セル: 同じ行の別セル（c5-7）に "YYYY年M月 〜 YYYY年M月 / X年Yヶ月"
 * - 環境行: "開発環境" ラベルの右のセルにスキルが ／ 区切りで入る
 */
function extractSkillYearsCircledNum(sorted: SpanCell[]): Record<string, number> {
  // ①〜⑳ (U+2460-U+2473)
  const CIRCLED_RE = /^[①-⑳]/
  const projectCells = sorted.filter(c => CIRCLED_RE.test(c.value.trim()))
  if (projectCells.length === 0) return {}

  const skillMonths: Record<string, number> = {}
  const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1
  const maxRow = Math.max(...sorted.map(c => c.rowEnd))
  let totalProjectMonths = 0
  const projectPeriods: Array<{ startYM: number; endYM: number }> = []

  for (let i = 0; i < projectCells.length; i++) {
    const ph = projectCells[i]
    const startRow = ph.row
    const endRow = i + 1 < projectCells.length
      ? projectCells[i + 1].row - 1
      : maxRow
    const blockCells = sorted.filter(c => c.row >= startRow && c.rowEnd <= endRow)

    // ── 期間の抽出 ──
    let months: number | null = null
    let startYM: number | null = null
    let endYM: number | null = null

    // ヵ/ヶ/か すべて対応する月パターン
    const tryExtractMonths = (v: string): number | null => {
      const dm = v.match(/[/／（(]\s*(\d+)年(\d+)[ヵヶか]月/)
      if (dm) return parseInt(dm[1]) * 12 + parseInt(dm[2])
      const dm2 = v.match(/(\d+)年(\d+)[ヵヶか]月/)
      if (dm2) return parseInt(dm2[1]) * 12 + parseInt(dm2[2])
      const ym3 = v.match(/[/／]\s*(\d+)年\s*$/)
      if (ym3) return parseInt(ym3[1]) * 12
      const mmS = v.match(/[（(]\s*(\d+)[ヵヶか]月\s*[）)]/)
      if (mmS) return parseInt(mmS[1])
      const mmS2 = v.match(/[/／]\s*(\d+)[ヵヶか]月/)
      if (mmS2) return parseInt(mmS2[1])
      return null
    }

    // まず同行から探す
    const sameRowCells = sorted.filter(c => c.row === ph.row && c !== ph)
    for (const rc of sameRowCells) {
      const v = rc.value.trim()
      months = tryExtractMonths(v)
      // "YYYY年M月 〜 YYYY年M月" → startYM/endYM を記録
      const rm = v.match(/(\d{4})年(\d{1,2})月.*?[〜～].*?(\d{4})年(\d{1,2})月/)
      if (rm) {
        startYM = parseInt(rm[1]) * 12 + parseInt(rm[2])
        endYM = parseInt(rm[3]) * 12 + parseInt(rm[4])
        if (!months) months = endYM - startYM + 1
      }
      if (!months) {
        const rm2 = v.match(/(\d{4})年(\d{1,2})月.*?[〜～].*?(現在|今|継続|在籍中)/i)
        if (rm2) {
          startYM = parseInt(rm2[1]) * 12 + parseInt(rm2[2])
          endYM = nowYM
          months = nowYM - startYM + 1
        }
      }
      if (months) break
    }

    // 同行になければブロック内全体を検索（NS型: 期間が別行に入るフォーマット）
    if (!months) {
      for (const bc of blockCells) {
        months = tryExtractMonths(bc.value.trim())
        if (months) break
      }
    }

    if (!months || months <= 0 || months > 600) continue
    totalProjectMonths += months
    if (startYM && endYM) projectPeriods.push({ startYM, endYM })

    // ── スキルの抽出 ──
    for (const cell of blockCells) {
      const cv = cell.value.trim()
      // S.Y型: 「開発環境」ラベル単体 → 右隣セルが値
      if (/^開発環境$/.test(cv)) {
        const valueCell = sorted.find(c => c.row === cell.row && c.col > cell.col)
        if (valueCell) {
          for (const seg of valueCell.value.split(/[/／\r\n、，,]+/)) {
            const skill = seg.trim()
            if (skill.length >= 2 && skill.length <= 50) {
              skillMonths[skill] = (skillMonths[skill] ?? 0) + months
            }
          }
        }
        break
      }
      // NS型: 「【開発環境】\nOS:...\nミドルウェア:...」マルチラインセル
      if (cv.includes('【開発環境】') || /^開発環境[:：]/.test(cv)) {
        const envContent = cv.replace(/^【?開発環境】?\s*/, '').replace(/^[:：]\s*/, '')
        for (const line of envContent.split(/[\r\n]+/)) {
          // "OS:" "ミドルウェア:" 等のラベルを除去して値だけ取る
          const colonIdx = Math.max(line.indexOf(':'), line.indexOf('：'))
          const content = colonIdx >= 0 ? line.slice(colonIdx + 1) : line
          for (const seg of content.split(/[、，,/／\s]+/)) {
            const skill = seg.trim()
            if (skill.length >= 2 && skill.length <= 50) {
              skillMonths[skill] = (skillMonths[skill] ?? 0) + months
            }
          }
        }
        break
      }
    }
  }

  if (Object.keys(skillMonths).length === 0) return {}

  if (totalProjectMonths > 0) skillMonths['_totalProjectMonths'] = totalProjectMonths
  if (projectPeriods.length > 0) {
    const allStarts = projectPeriods.map(p => p.startYM)
    const allEnds = projectPeriods.map(p => p.endYM)
    const span = Math.max(...allEnds) - Math.min(...allStarts) + 1
    if (span > 0) skillMonths['_dateSpanMonths'] = span
  }

  console.log(`[skillYears-circled] projects=${projectCells.length} skills=${Object.keys(skillMonths).filter(k => !k.startsWith('_')).length}`)
  return skillMonths
}

/**
 * SpanCell[] からプロジェクトブロック単位でスキル別経験月数を抽出する。
 * grid ベースの extractSkillYearsUnified が失敗するケース（セル結合で列構造が崩れるフォーマット）のフォールバック。
 *
 * 対応フォーマット:
 *   - D.U 型: No. ヘッダー行 → 日付行 → 【言語】マルチラインブロック
 *   - T.K/H.A 型: No.(rs≥3) → 期間(rs≥3) → 日付行 → 「言語 FW」行 → スキル行
 *   - S.Y 型: ①〜⑳始まりセル → 同行の期間セル → 「開発環境」行のスキル（extractSkillYearsCircledNum にフォールバック）
 */
function extractSkillYearsFromCells(cells: SpanCell[], deadline = 0): Record<string, number> {
  if (cells.length === 0) return {}
  if (deadline && Date.now() > deadline) return {}
  const sorted = [...cells].sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col)
  const _rsC = (c: SpanCell) => c.rowEnd - c.row + 1

  // ── Step 1: No. セルでプロジェクト境界を特定 ──
  const noCells = sorted.filter(c => /^(No\.?|№|項番)$/i.test(c.value.trim()))
  if (noCells.length === 0) {
    const circled = extractSkillYearsCircledNum(sorted)
    if (Object.keys(circled).length > 0) return circled
    return extractSkillYearsPeriodHeader(sorted)
  }

  // ヘッダー No.（最初の No.）とデータ No. を分離
  // ヘッダー行: 同じ行に「期間」「内容」等のラベルが並ぶ
  const firstNo = noCells[0]
  const sameRowLabels = sorted.filter(c => c.row === firstNo.row && c !== firstNo)
  const isHeaderRow = sameRowLabels.some(c => /^(期間|内容|案件名|業務内容|システム名|業種)$/.test(c.value.trim()))

  // プロジェクト境界の行範囲を決定
  interface ProjectBlock { startRow: number; endRow: number }
  const blocks: ProjectBlock[] = []

  // D.U 型: ヘッダー行(rs=1) の下に No.=1,2,3... が来るのではなく、
  //          ヘッダー行が繰り返される（各プロジェクトが独立したヘッダー+データ構造）
  // T.K 型: No.(rs≥3) 自体がプロジェクトブロックの開始マーカー
  // M.T 型: No ヘッダーが1個だけ → 下の数字セル(1,2,3...)でブロック分割

  if (noCells.length === 1) {
    // M.T 型: No ヘッダーが1個だけ → 下の同列にある数字セル(1,2,3...)をプロジェクト境界にする
    // isHeaderRow に依存せず、数字セルの有無で判断（KK 型: "開始年月"等のラベルでも対応）
    const noCol = firstNo.col
    const numberCells = sorted.filter(c =>
      c.col === noCol && c.row > firstNo.rowEnd && /^\d+$/.test(c.value.trim())
    ).sort((a, b) => a.row - b.row)
    if (numberCells.length > 0) {
      for (let i = 0; i < numberCells.length; i++) {
        const startRow = numberCells[i].row
        const endRow = i + 1 < numberCells.length ? numberCells[i + 1].row - 1 : Math.max(...sorted.map(c => c.rowEnd))
        blocks.push({ startRow, endRow })
      }
    } else {
      // 数字セルが見つからない場合はヘッダー行以降を1ブロックとする
      blocks.push({ startRow: firstNo.row, endRow: Math.max(...sorted.map(c => c.rowEnd)) })
    }
  } else if (isHeaderRow) {
    // D.U 型: ヘッダー行が繰り返されるパターン
    // 各 No. セルの行 = ヘッダー行、その下がデータ
    // A.N 型: 各 No. セクション内に数字セルが存在する場合はさらに M.T 型分割を適用
    const maxRow = Math.max(...sorted.map(c => c.rowEnd))
    for (let i = 0; i < noCells.length; i++) {
      const sectionStart = noCells[i].row
      const sectionEnd = i + 1 < noCells.length ? noCells[i + 1].row - 1 : maxRow
      const noCol = noCells[i].col
      const subNums = sorted.filter(c =>
        c.col === noCol && c.row > noCells[i].rowEnd && c.row <= sectionEnd && /^\d+$/.test(c.value.trim())
      ).sort((a, b) => a.row - b.row)
      if (subNums.length > 0) {
        // A.N 型: セクション内を数字セルでさらに分割
        for (let j = 0; j < subNums.length; j++) {
          const startRow = subNums[j].row
          const endRow = j + 1 < subNums.length ? subNums[j + 1].row - 1 : sectionEnd
          blocks.push({ startRow, endRow })
        }
      } else {
        blocks.push({ startRow: sectionStart, endRow: sectionEnd })
      }
    }
  } else {
    // T.K 型: No.(rs≥3) 自体がブロック開始
    for (let i = 0; i < noCells.length; i++) {
      const startRow = noCells[i].row
      const endRow = i + 1 < noCells.length ? noCells[i + 1].row - 1 : Math.max(...sorted.map(c => c.rowEnd))
      blocks.push({ startRow, endRow })
    }
  }

  // ── Step 2: 各ブロックから期間（月数）とスキルを抽出 ──
  const skillMonths: Record<string, number> = {}
  const projectPeriods: Array<{ startYM: number; endYM: number }> = []
  const DATE_RE = /(\d{2,4})[\/\-年](\d{1,2})/
  const SERIAL_MIN = 36526 // 2000-01-01
  const SERIAL_MAX = 48000 // ~2031
  const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1

  // US 日付形式 M/D/YY or M/D/YYYY
  const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/

  const parseYM = (s: string): number | null => {
    // Excel シリアル日付
    const num = parseFloat(s)
    if (!isNaN(num) && num >= SERIAL_MIN && num <= SERIAL_MAX) {
      const d = new Date(Date.UTC(1899, 11, 30) + num * 86400000)
      return d.getUTCFullYear() * 12 + d.getUTCMonth() + 1
    }
    // YYYY/MM or YY年MM月 形式
    const m = s.match(DATE_RE)
    if (m) {
      let year = parseInt(m[1])
      if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
      return year * 12 + parseInt(m[2])
    }
    // US 日付形式 M/D/YY → YY<50 は 20YY、50以上は 19YY
    const usm = s.trim().match(US_DATE_RE)
    if (usm) {
      const month = parseInt(usm[1])
      let year = parseInt(usm[3])
      if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
      if (month >= 1 && month <= 12 && year >= 1970 && year <= 2100) return year * 12 + month
    }
    return null
  }
  const resolveEnd = (s: string): number | null => {
    if (/現在|今|present|継続|在籍中/i.test(s)) return nowYM
    return parseYM(s)
  }

  // スキルブロッカー（スキルとして拾わないラベル）
  const SKILL_BLOCK = /^(No\.?|期間|案件名|内容|業務内容|計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|担当工程|担当業務|規模|開発人数|備考|ポジション|役割|雇用形態|チーム|人数|改修|調査|テスト|固定|立場|氏名|年齢|性別|言語|FW|ツール|OS|DB|環境|フレームワーク|ミドル|インフラ|クラウド|データベース|スキル|経歴|能力指標|OS\s.*etc)$/i

  for (const block of blocks) {
    const blockCells = sorted.filter(c => c.row >= block.startRow && c.row <= block.endRow)

    // ── 期間の抽出 ──
    let months: number | null = null
    let startYM: number | null = null
    let endYM: number | null = null

    // ① 分割セル型の期間集計（H.E 型: "0"+"年"+"9"+"ヶ月" が別セルに分散）— 最優先
    {
      const rowNums = [...new Set(blockCells.map(c => c.row))]
      for (const rn of rowNums) {
        const rowCells = blockCells.filter(c => c.row === rn)
        const monthMarker = rowCells.find(c => /^[ヶか]月$/.test(c.value.trim()))
        const yearMarker = rowCells.find(c => c.value.trim() === '年')
        if (monthMarker && yearMarker) {
          const yearNumCell = rowCells.filter(c => c.col < yearMarker.col && /^\d+$/.test(c.value.trim())).pop()
          const monthNumCell = rowCells.filter(c => c.col > yearMarker.col && c.col < monthMarker.col && /^\d+$/.test(c.value.trim())).pop()
          if (yearNumCell && monthNumCell) {
            const yy = parseInt(yearNumCell.value.trim())
            const mm = parseInt(monthNumCell.value.trim())
            if (yy >= 0 && yy <= 50 && mm >= 0 && mm <= 11) {
              months = yy * 12 + mm
              if (months === 0) months = null
              if (months) break
            }
          }
        }
      }
    }

    // ② 分割セル型の開始/終了年月（H.E 型: "2025"+"年"+"9"+"月"）
    {
      const rowNums = [...new Set(blockCells.map(c => c.row))]
      const dateYMs: number[] = []
      for (const rn of rowNums) {
        const rowCells = blockCells.filter(c => c.row === rn)
        const yearMarker = rowCells.find(c => c.value.trim() === '年')
        const monthMarkerExact = rowCells.find(c => c.value.trim() === '月')
        if (yearMarker && monthMarkerExact) {
          const yearNumCell = rowCells.filter(c => c.col < yearMarker.col && /^\d{4}$/.test(c.value.trim())).pop()
          const monthNumCell = rowCells.filter(c => c.col > yearMarker.col && c.col < monthMarkerExact.col && /^\d{1,2}$/.test(c.value.trim())).pop()
          if (yearNumCell && monthNumCell) {
            const y = parseInt(yearNumCell.value.trim())
            const m = parseInt(monthNumCell.value.trim())
            if (y >= 1970 && y <= 2100 && m >= 1 && m <= 12) dateYMs.push(y * 12 + m)
          }
        }
        const currentCell = rowCells.find(c => /^(現在|今|present|継続|在籍中)$/i.test(c.value.trim()))
        if (currentCell) dateYMs.push(nowYM)
      }
      if (dateYMs.length >= 2) {
        startYM = Math.min(...dateYMs)
        endYM = Math.max(...dateYMs)
        if (!months) months = endYM - startYM + 1
      }
    }

    // ③ 日付っぽいセルを収集（YYYY/MM、US形式 M/D/YY、シリアル日付）
    if (!months) {
      const dateCells = blockCells.filter(c => {
        const v = c.value.trim()
        return DATE_RE.test(v) || US_DATE_RE.test(v) || (!isNaN(parseFloat(v)) && parseFloat(v) >= SERIAL_MIN && parseFloat(v) <= SERIAL_MAX)
      })
      if (dateCells.length >= 2) {
        const yms = dateCells.map(c => parseYM(c.value.trim())).filter((v): v is number => v !== null)
        if (yms.length >= 2) {
          startYM = Math.min(...yms)
          endYM = Math.max(...yms)
          months = endYM - startYM + 1
        }
      } else if (dateCells.length === 1) {
        const ym = parseYM(dateCells[0].value.trim())
        if (ym) { startYM = ym; endYM = ym; months = 12 }
      }
    }

    // ④ 期間テキスト（"2020/04〜2023/03" 形式）
    if (!months) {
      for (const c of blockCells) {
        const pm = c.value.match(/(\d{4}[\/年]\d{1,2})\s*[〜～\-〜]\s*(\S+)/)
        if (pm) {
          startYM = parseYM(pm[1])
          endYM = resolveEnd(pm[2])
          if (startYM && endYM) { months = endYM - startYM + 1; break }
        }
      }
    }

    // ⑤ "X年Yヶ月" / "Xか月" 単一セル（M.T 型）
    if (!months) {
      for (const c of blockCells) {
        const v = c.value.trim()
        const dm = v.match(/(\d+)年(\d+)[ヶか]月/)
        if (dm) { months = parseInt(dm[1]) * 12 + parseInt(dm[2]); break }
        const mm = v.match(/^(\d+)[ヶか]月$/)
        if (mm) { months = parseInt(mm[1]); break }
        const normalized = v.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        const dm3 = normalized.match(/(\d+)年(\d+)[ヶか]月/)
        if (dm3) { months = parseInt(dm3[1]) * 12 + parseInt(dm3[2]); break }
        const mm2 = normalized.match(/^(\d+)[ヶか]月$/)
        if (mm2) { months = parseInt(mm2[1]); break }
      }
    }

    if (!months || months <= 0 || months > 600) continue
    if (startYM && endYM) projectPeriods.push({ startYM, endYM })

    // ── スキルの抽出 ──
    const blockSkills: string[] = []

    // パターン A: 【言語】マルチラインブロック（D.U 型）
    const langBlocks = blockCells.filter(c => c.value.includes('【言語】') && _rsC(c) >= 3)
    if (langBlocks.length > 0) {
      for (const lb of langBlocks) {
        // 【言語】\r\n Java\r\n Python\r\n【OS】\r\n Mac... から言語セクションを抽出
        const lines = lb.value.split(/\r?\n/).map(l => l.trim()).filter(l => l)
        let inLangSection = false
        for (const line of lines) {
          if (/^【(言語|FW|フレームワーク|ツール|DB|データベース|インフラ|クラウド|ミドルウェア)】/.test(line)) {
            inLangSection = true
            continue
          }
          if (/^【/.test(line)) { inLangSection = false; continue }
          if (inLangSection && line !== '-' && line !== '－' && line.length >= 2) {
            // "/" 区切りも分割（"HTML/CSS" → "HTML/CSS" はそのまま）
            blockSkills.push(line)
          }
        }
      }
    }

    // パターン B: 「言語 FW」ラベルの下方（同列範囲のみ）からスキル値を収集（T.K/H.A 型）
    if (blockSkills.length === 0) {
      const langLabelCells = blockCells.filter(c =>
        /^(言語|使用言語|言語\s*FW|使用技術|技術スタック)$/i.test(c.value.trim().replace(/[\r\n]/g, ' ').trim())
      )
      for (const ll of langLabelCells) {
        // ラベルと同じ列範囲の下方セルのみ検索（右の業務内容を拾わない）
        const candidates = blockCells.filter(c =>
          c !== ll && c.row > ll.row && c.row <= ll.row + 5 &&
          c.col >= ll.col && c.colEnd <= ll.colEnd + 2
        )
        for (const cc of candidates) {
          const v = cc.value.trim()
          if (v && v !== '-' && v !== '－' && v.length >= 2 && v.length <= 50 && !SKILL_BLOCK.test(v) && !/^[◎○◇△▲×〇]+$/.test(v)) {
            for (const s of v.split(/[\n\r、，,]+/).map(s2 => s2.trim()).filter(s2 => s2 && s2.length >= 2 && s2 !== '-')) {
              blockSkills.push(s)
            }
          }
        }
      }
    }

    // パターン C: 【OS】/【環境】マルチラインブロック（rs≥2）からツール名を抽出
    const osEnvBlocks = blockCells.filter(c => c.value.includes('【OS】') && _rsC(c) >= 2)
    for (const ob of osEnvBlocks) {
      const lines = ob.value.split(/\r?\n/).map(l => l.trim()).filter(l => l)
      let inSection = false
      for (const line of lines) {
        if (/^【(OS|環境|ツール|アプリ|ミドルウェア)】/.test(line)) { inSection = true; continue }
        if (/^【/.test(line)) { inSection = false; continue }
        if (inSection && line !== '-' && line !== '－' && line.length >= 2 && line.length <= 40) {
          blockSkills.push(line)
        }
      }
    }

    // パターン D: M.T 型 — ヘッダー行の「OS等」「DB/DC」「言語/ツール等」列位置から、同列のブロック内セルを取得
    if (blockSkills.length === 0) {
      // ヘッダー行（blocks の前）からスキル列の位置を特定
      const headerCells = sorted.filter(c => c.row >= firstNo.row && c.row <= firstNo.rowEnd)
      const skillColCells = headerCells.filter(c => {
        // 改行区切りのセル（"言語\nツール" / "OS\nDB"）は各行を個別に検査
        const lines = c.value.trim().split(/[\r\n]+/).map(l => l.trim()).filter(l => l)
        const v = lines.join(' ')
        // 全角英数→半角英数に正規化してマッチ
        const vNorm = v.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        return /^(OS等?|DB\/DC|言語\/ツール等?|言語|ツール|DB|DCその他|環境|機種)$/.test(vNorm) ||
          /機種\s*OS|使用言語|使用技術|技術スタック|サーバ\s*OS|FW[・／]|ミドルウェア|開発環境/i.test(vNorm) ||
          /^環境[・・]?(言語|ツール|スキル)|^(言語|ツール)[・・]?環境|(言語|環境)[・・]?等$/.test(vNorm) ||
          /機種[・]?OS|ツール(他|類)$|ＤＢ/i.test(vNorm) ||
          // 複数行ヘッダー: "言語\nツール" / "OS\nDB" → 各行を個別チェック
          lines.some(l => {
            const ln = l.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
            return /^(OS等?|言語|ツール|DB|FW)$/.test(ln)
          }) ||
          // I.T 型: 「インフラ環境」/「アプリケーション環境」列ヘッダー
          /インフラ環境|アプリケーション環境/.test(vNorm)
      })
      for (const hdr of skillColCells) {
        // ヘッダーと同じ列のブロック内セルからスキルを取得（「機種」列は PC/サーバ等でスキップ）
        if (/^機種$/.test(hdr.value.trim())) continue
        const colCells = blockCells.filter(c =>
          c.col >= hdr.col && c.col <= hdr.colEnd && c.row > firstNo.rowEnd
        )
        for (const cc of colCells) {
          const v = cc.value.trim()
          if (!v || v === '-' || v === '－' || v.length < 2) continue
          // 業務内容テキスト（長文）は除外（ただし改行区切りのスキルリストは許容: 200文字まで）
          if (v.length > 200 && v.includes('\n')) continue
          // 改行→行ごとに2+空白/全角スペース/カンマで分割（"Excel VBA"の単一スペースは保持）
          for (const line of v.split(/[\r\n]+/)) {
            // ラベル専用セル（"OS："/ "開発言語："等、末尾が：のみの行）はスキップ
            if (/[：:]\s*$/.test(line.trim())) continue
            for (let s of line.split(/[、，,]+|　|\s{2,}/).map(s2 => s2.trim()).filter(s2 => s2 && s2.length >= 2 && s2 !== '-' && s2 !== '－')) {
              // バージョン番号サフィックスを除去: "Laravel：12.0" → "Laravel"
              const colonVerIdx = s.indexOf('：')
              if (colonVerIdx > 0 && /^\d[\d.]+$/.test(s.slice(colonVerIdx + 1).trim())) {
                s = s.slice(0, colonVerIdx).trim()
                if (!s || s.length < 2) continue
              }
              // 括弧が不完全なフラグメントを処理: "Azure(RG" → "Azure", "WAF等)" → skip
              const openP = (s.match(/[（(]/g) || []).length
              const closeP = (s.match(/[）)]/g) || []).length
              if (openP > closeP) {
                s = s.replace(/[（(].*$/, '').trim()
                if (!s || s.length < 2) continue
              } else if (closeP > openP) {
                continue
              }
              if (!SKILL_BLOCK.test(s) && !/^[◎○◇△▲×〇]+$/.test(s) && !/^\d+$/.test(s) && !/^[<＜][^>＞]+[>＞]$/.test(s)) {
                blockSkills.push(s)
              }
            }
          }
        }
      }
    }

    // パターン E: インラインラベル値ペア（I.T 型）
    // 同一行内で「技術ラベル：」のセルの右隣セルがスキル値（"OS：" → "Windows11"）
    if (blockSkills.length === 0) {
      const INLINE_LBL_RE = /^(OS|開発?言語|Framework|FW|DB|データベース|クラウド|ミドルウェア|仮想化|Network|Storage|Strage|Application|Other)[：:]\s*$/i
      const sortedBlock = [...blockCells].sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col)
      for (let i = 0; i < sortedBlock.length - 1; i++) {
        const lbl = sortedBlock[i]
        if (!INLINE_LBL_RE.test(lbl.value.trim())) continue
        const nxt = sortedBlock[i + 1]
        if (nxt.row !== lbl.row || nxt.col <= lbl.colEnd) continue
        let sv = nxt.value.trim()
        if (!sv || sv === '-' || sv === '－' || sv.length < 2) continue
        // バージョン番号サフィックスを除去: "Laravel：12.0" → "Laravel"
        const cvIdx = sv.indexOf('：')
        if (cvIdx > 0 && /^\d[\d.]+$/.test(sv.slice(cvIdx + 1).trim())) sv = sv.slice(0, cvIdx).trim()
        if (!sv || SKILL_BLOCK.test(sv) || /^[◎○◇△▲×〇]+$/.test(sv)) continue
        for (const part of sv.split(/[,、，\/]+/).map(s => s.trim()).filter(s => s.length >= 2 && s !== '-')) {
          blockSkills.push(part)
        }
      }
    }

    // スキルに月数を加算（先頭の「- 」「・」を除去、改行区切りの複合セルは個別スキルに分離）
    // 同一ブロック内で複数スキル列に同じスキルが重複しないよう Set で正規化してから加算
    const blockSkillSet = new Set<string>()
    for (let skill of blockSkills) {
      // セル内改行で複数スキルが入っている場合は分離（例: "Win10\nAWS\nLinux"）
      const subSkills = skill.includes('\n') ? skill.split('\n') : [skill]
      for (let sub of subSkills) {
        sub = sub.replace(/^[-・]\s*/, '').trim()
        // 括弧付き補足を除去（例: "(CloudSearch)" → 独立扱いしない）
        if (/^\([^)]+\)$/.test(sub) || /^（[^）]+）$/.test(sub)) continue
        if (sub.length < 2) continue
        blockSkillSet.add(sub)
      }
    }
    for (const sub of blockSkillSet) {
      skillMonths[sub] = (skillMonths[sub] ?? 0) + months
    }
  }

  if (Object.keys(skillMonths).length === 0) return {}

  // _totalProjectMonths / _dateSpanMonths
  if (projectPeriods.length > 0) {
    skillMonths['_totalProjectMonths'] = projectPeriods.reduce((s, p) => s + (p.endYM - p.startYM + 1), 0)
    const allStarts = projectPeriods.map(p => p.startYM)
    const allEnds = projectPeriods.map(p => p.endYM)
    const span = Math.max(...allEnds) - Math.min(...allStarts) + 1
    if (span > 0) skillMonths['_dateSpanMonths'] = span
  }

  console.log(`[skillYears-cells] projects=${blocks.length} skills=${Object.keys(skillMonths).filter(k => !k.startsWith('_')).length}`)
  return filterSkillYears(skillMonths)
}

/** スキル別経験月数を Excel ファイル（base64）から抽出 */
async function extractSkillYearsFromExcel(base64: string): Promise<Record<string, number>> {
  const { skillYears } = await extractExcelAll(base64)
  return skillYears
}

/**
 * Excel を 1 回だけパースし、テキストと skillYears を同時に返す。
 * SheetJS の !merges を直接読み取り、HTML 経由なしで grids / SpanCell[] を生成する。
 * sheet_to_html を廃止して中間変換ノイズ（空セル混入・文字列変換ズレ）を除去。
 * sheet_to_json では結合セルが __EMPTY_N になり構造が破壊されるため使用しない。
 */
async function extractExcelAll(base64: string, opts?: { gidCsvRows?: string[][] }): Promise<{ text: string; skillYears: Record<string, number>; jsonRows?: Array<Record<string, string>>; skillSummary?: string; parseError?: string; grid?: string[][]; links?: { cell: string; url: string }[]; sheetPickedBy?: 'gid' | 'keyword' }> {
  try {
    const XLSX = npmDefault(await import('npm:xlsx@0.18.5')) as {
      read: (data: Uint8Array, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
    }
    const bytes = base64ToUint8Array(base64)
    const workbook = XLSX.read(bytes, { type: 'array' })
    const PRIORITY_KEYWORDS = ['スキル', '経歴', '職務', 'スキルシート', 'skill', 'career', 'profile', '人材']
    // 「〜（入力後に非表示）」「チェックリスト」等、作成者向けの記入補助・確認用シートは
    // 候補者の実データを含まない（テンプレートの選択肢例や別人の記入例が残っていることがある）ため除外する。
    // これらのシート名はテンプレート製作者名に依存せず概ね共通のパターンで出現する。
    // 「〜（比較用）」は、旧テンプレートを流用した際に残った全く無関係な別人の経歴書が
    // 比較参考として同梱されているケースがあり、混入すると経験年数・スキル年数が
    // 誤って計算される（実例: IT.xlsx に「現行経歴書(比較用)」として無関係な別候補者の
    // 経歴書が同梱され、その短い前職バイト歴が本人の経験年数として誤って採用された）。
    const EXCLUDE_SHEET_RE = /入力後.{0,2}非表示|非表示|チェックリスト|記入例|Sample|テンプレート|比較用/i
    const sortedNames = [...workbook.SheetNames]
      .filter(name => !EXCLUDE_SHEET_RE.test(name))
      .sort((a, b) => {
        const ap = PRIORITY_KEYWORDS.some(kw => a.toLowerCase().includes(kw.toLowerCase())) ? 0 : 1
        const bp = PRIORITY_KEYWORDS.some(kw => b.toLowerCase().includes(kw.toLowerCase())) ? 0 : 1
        return ap - bp
      })
    // ゾーンB: gidフィンガープリント照合（設計書v4・穴①対策）
    // Sheetsリンク経由でgid指定CSVが取れている場合、その中身と一致するシートを最優先にする。
    // 送信者が明示的に指したタブという添付には無い強いシグナルを活かし、キーワードソートより
    // 確実に対象シートを特定する。照合不能ならキーワードソートに落ちるだけで後退はしない。
    let sheetPickedBy: 'gid' | 'keyword' | undefined
    if (opts?.gidCsvRows && opts.gidCsvRows.length > 0 && sortedNames.length > 1) {
      const heads = sortedNames.slice(0, 8).map(name => {
        const sh = workbook.Sheets[name] as Record<string, unknown> | undefined
        if (!sh || !sh['!ref']) return { name, head: [] as string[][] }
        return { name, head: worksheetToGrid(sh).slice(0, 6) }
      })
      const matched = matchSheetByFingerprint(heads, opts.gidCsvRows)
      if (matched) {
        sortedNames.splice(sortedNames.indexOf(matched), 1)
        sortedNames.unshift(matched)
        sheetPickedBy = 'gid'
      }
    }
    if (!sheetPickedBy && sortedNames.length > 0) sheetPickedBy = 'keyword'
    const texts: string[] = []
    let skillYears: Record<string, number> = {}
    let firstJsonRows: Array<Record<string, string>> | undefined
    let firstGrid: string[][] | undefined
    // セル単位ハイパーリンク（rels相当・SheetJSのlプロパティ）— 名簿リンク型検出の基盤
    const allLinks: { cell: string; url: string }[] = []
    for (const sheetName of sortedNames.slice(0, 3)) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet || !(sheet as Record<string, unknown>)['!ref']) {
        console.warn(`[Excel] シート "${sheetName}" は空のためスキップ`)
        continue
      }

      // Excel（SheetJS）直接 → グリッド / SpanCell[]（HTML 経由廃止）
      const sheetObj = sheet as Record<string, unknown>
      const mergeCount = ((sheetObj['!merges'] as unknown[]) || []).length
      const grid = worksheetToGrid(sheetObj)
      const cells = worksheetToCells(sheetObj)
      console.log(`[Excel-parse] sheet="${sheetName}" merges=${mergeCount} cells=${cells.length} gridRows=${grid.length}`)
      if (!firstGrid && grid.length > 0) firstGrid = grid
      for (const [addr, cellVal] of Object.entries(sheetObj)) {
        if (addr.startsWith('!')) continue
        const linkTarget = (cellVal as { l?: { Target?: string } }).l?.Target
        if (linkTarget && /^https?:\/\//.test(linkTarget)) allLinks.push({ cell: addr, url: linkTarget })
      }

      // フィールド抽出用テキスト（gridToText 経由）
      const gridText = gridToFieldText(grid)
      // 全テキストを1000字ずつ分割してログ出力
      const chunkSize = 1000
      for (let ci = 0; ci < gridText.length; ci += chunkSize) {
        console.log(`[Excel-text] sheet="${sheetName}" chunk=${Math.floor(ci/chunkSize)} text=${JSON.stringify(gridText.slice(ci, ci + chunkSize))}`)
      }
      if (gridText.trim()) texts.push(`--- シート: ${sheetName} ---\n${gridText}`)

      // skillYears 抽出: grid ベースと SpanCell ベースの両方を試し、スキル数が多い方を採用
      if (Object.keys(skillYears).length === 0) {
        // 全抽出で共有する1つの時間予算（合計3.5秒）。各関数に別々の予算を渡すと順次実行で合算され
        // 13秒以上かかり546リソース超過→候補者消失になる実害があった（1-r.co.jp「展開用」テンプレ）。
        // 546は6.4秒でも発動するため、抽出以外の処理(~2秒)を足しても6秒未満に収まるよう短めにする。
        // 超過時は各関数が部分結果/空を返し、最終的に軽量な grid 結果へ退化する（546を根絶）。
        const sheetDeadline = Date.now() + 3500
        const jsonRows = spanCellsToJson(cells, sheetDeadline)
        if (Date.now() > sheetDeadline) console.warn(`[Excel-json] TIMEOUT sheet="${sheetName}" 時間予算超過のため部分結果で打ち切り rows=${jsonRows.length}`)
        console.log(`[Excel-json] sheet="${sheetName}" totalRows=${jsonRows.length} rows=${JSON.stringify(jsonRows.slice(0, 10))}`)
        const syGrid = extractSkillYearsUnified(grid)
        const syCells = filterSkillYears(extractSkillYearsFromCells(cells, sheetDeadline))
        // 視覚エンジン（罫線・色・文字。明示スキル表と判定された場合のみ・失敗時は必ずnull）
        const syVisual = Date.now() > sheetDeadline ? null : await tryVisualSkillExtraction(bytes, sheetName, cells, sheetDeadline)
        // 案件系視覚リーダー（スキル表が無い案件履歴向け。縦結合セルで案件ブロック化→期間×tech区間union。
        // 信頼ゲート＝tech列2本以上＋案件3件以上＋結果3件以上を満たす時のみ非null）
        const syProject = (syVisual || Date.now() > sheetDeadline) ? null : extractSkillYearsVisualProject(cells, sheetDeadline)
        // 品質スコア比較（件数→skill_master照合の重み付き。同点は SpanCell 優先＝空間構造が正確）
        const countGrid = scoreSkillQuality(syGrid, _skillNameSet)
        const countCells = scoreSkillQuality(syCells, _skillNameSet)
        const countVisual = syVisual ? scoreSkillQuality(syVisual, _skillNameSet) : 0
        const countProject = syProject ? scoreSkillQuality(syProject, _skillNameSet) : 0
        if (countGrid > 0 || countCells > 0 || countVisual > 0 || countProject > 0) {
          // 明示スキル表（本人申告）を第一優先。tryVisualSkillExtraction は空行ブロック単位で
          // 'skill' 判定・罫線ボックス・列頻度3以上を満たす真の明示スキル表ブロックからしか
          // 非nullを返さないため、読めた時点でそれを最優先する（案件tech列×期間のunionより、
          // 本人が申告した「スキル歴N年」を優先するというユーザー方針）。
          if (syVisual && countVisual > 0) {
            skillYears = syVisual
            skillYears['_extractMethod'] = 60 // 視覚エンジン（明示スキル表・罫線色KV）勝者
          } else if (syProject && countProject >= countGrid) {
            // スキル表が無い案件履歴。案件系視覚リーダーが信頼ゲートを通り、gridと同等以上に
            // 取れた時は grid より優先（構造で読む方がノイズが少なく期間×tech対応も正確）。
            skillYears = syProject
            skillYears['_extractMethod'] = 61 // 視覚エンジン（案件ブロック区間union）勝者
          } else {
            skillYears = countCells >= countGrid ? syCells : syGrid
          }
          // cells ベースの _totalProjectMonths / _dateSpanMonths を常に保持（grid にはこの情報がない）
          if (syCells['_totalProjectMonths'] && !skillYears['_totalProjectMonths']) {
            skillYears['_totalProjectMonths'] = syCells['_totalProjectMonths']
          }
          if (syCells['_dateSpanMonths'] && !skillYears['_dateSpanMonths']) {
            skillYears['_dateSpanMonths'] = syCells['_dateSpanMonths']
          }
          // SpanCellベース勝者には経路コード50を付与（gridベースはUnified内で付与済み）
          if (skillYears['_extractMethod'] === undefined) skillYears['_extractMethod'] = 50
          firstJsonRows = jsonRows
          const winner = (syVisual && countVisual > 0) ? 'visual'
            : (syProject && countProject >= countGrid) ? 'project'
            : (countCells >= countGrid ? 'cells' : 'grid')
          console.log(`[skillYears-pick] grid=${countGrid} cells=${countCells} visual=${countVisual} project=${countProject} winner=${winner}`)
        } else {
          console.log(`[skillYears-miss] sheet="${sheetName}" totalRows=${grid.length} head=${JSON.stringify(grid.slice(0, 3).map(r => r.slice(0, 8)))}`)
          if (!firstJsonRows) firstJsonRows = jsonRows
          // フォールバック: 列構造が崩れてスキル列・期間列を検出できない自由記述型の
          // 経歴書（ゲーム業界のプロジェクト単位の記述等）でも、案件ごとの「期間」セル単体
          // （例: "0年11ヶ月"）が jsonRows に残っていることがあるため、それらを合算する
          const fallbackMonths = sumStandaloneDurationValues(jsonRows)
          if (fallbackMonths > 0) {
            skillYears = { _totalProjectMonths: fallbackMonths }
            firstJsonRows = jsonRows
            console.log(`[skillYears-fallback] sheet="${sheetName}" totalProjectMonths=${fallbackMonths}（単体期間セル合算）`)
          } else {
            // さらなるフォールバック: 「2016年5月〜2022年10月」のような日付範囲表記から
            // 在籍全体のスパンを概算する（外資コンサル系の職務経歴書等で使用）
            const spanMonths = estimateDateSpanMonthsFromRows(jsonRows)
            if (spanMonths && spanMonths > 0) {
              skillYears = { _dateSpanMonths: spanMonths }
              firstJsonRows = jsonRows
              console.log(`[skillYears-fallback] sheet="${sheetName}" dateSpanMonths=${spanMonths}（日付スパン概算）`)
            }
          }
        }
      }
    }
    const text = texts.join('\n\n')
    // スキルサマリをjsonRowsから抽出
    const SKILL_SUMMARY_RE = /^スキルサマリ[ー]?$/
    let skillSummary: string | undefined
    if (firstJsonRows) {
      for (const row of firstJsonRows) {
        const key = Object.keys(row).find(k => SKILL_SUMMARY_RE.test(k.trim()))
        if (key && row[key]) { skillSummary = row[key]; break }
      }
    }
    return { text, skillYears, jsonRows: firstJsonRows, skillSummary, grid: firstGrid, links: allLinks.length > 0 ? allLinks : undefined, sheetPickedBy }
  } catch (e) {
    console.warn('[Excel] 抽出失敗', e)
    return { text: '', skillYears: {}, parseError: e instanceof Error ? e.message : String(e) }
  }
}

/** Excel(.xlsx/.xls)をCSVテキストに変換してクレンジング（最初の3シートまで） */
async function extractExcelText(base64: string): Promise<string> {
  const { text } = await extractExcelAll(base64)
  return text
}

/** 10秒タイムアウト付きfetch */
async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 統一入力パイプライン（設計書v4: ゾーンA〜E・T）
// メール添付・Drive単体ファイル・Sheetsリンク・Docsリンクの4系統を SourceEntry に
// 正規化し、これより下流には入力ソース別の分岐を置かない。
// ═══════════════════════════════════════════════════════════════════════════

/** ゾーンA: 正規化済み入力エントリ（全ソース共通・officeTextContents互換の上位集合） */
interface SourceEntry {
  entryId: number
  label: string
  content: string
  filename: string
  kind: 'excel' | 'word' | 'pdf' | 'text'
  origin: 'attachment' | 'drive' | 'sheets' | 'docs'
  skillYears?: Record<string, number>
  attachment?: Attachment
  jsonRows?: Array<Record<string, string>>
  skillSummary?: string
  grid?: string[][]
  links?: { cell: string; url: string }[]
  totalProjectMonths?: number
  gidHint?: { gid: string; csvRows?: string[][] }
  sourceUrl?: string
  /** 名簿行エントリの場合のみ: 親エントリID */
  parentId?: number
  /** 名簿行エントリの場合のみ: 行の氏名（氏名照合ゲート・新規候補者化で使用） */
  rosterRowName?: string
}

/**
 * ゾーンT: エントリ台帳。各エントリのステージコード列と不変条件違反を記録する。
 * 台帳の最終コードが「どこでこけたか」を示す。全ログに [trace:rid] を統一装着し、
 * Supabaseログで1通の全行程をgrep一発で追えるようにする。
 */
function createLedger(rid: string) {
  const rows: { entryId: number | null; code: string; detail?: string }[] = []
  const violations: string[] = []
  let seq = 0
  return {
    rid,
    nextEntryId(): number { seq += 1; return seq },
    log(entryId: number | null, code: string, detail?: string) {
      rows.push({ entryId, code, detail })
      console.log(`[trace:${rid}] [${code}]${entryId != null ? ` entry=${entryId}` : ''}${detail ? ` ${detail}` : ''}`)
    },
    /** 不変条件違反（サイレント失敗の検出器）。処理は止めず記録のみ */
    violate(code: string, detail?: string) {
      violations.push(detail ? `${code}(${detail.slice(0, 120)})` : code)
      console.warn(`[trace:${rid}] [${code}] INVARIANT VIOLATION ${detail ?? ''}`)
    },
    /** 候補者割当エントリの台帳＋メール全体サマリーを raw_profile.pipeline_trace 用に直列化（8KB上限） */
    serializeTrace(assignedEntryIds: number[]): Record<string, unknown> | undefined {
      const byEntry = new Map<number, string[]>()
      for (const r of rows) {
        if (r.entryId == null) continue
        const list = byEntry.get(r.entryId) ?? []
        list.push(r.detail ? `${r.code}(${r.detail.slice(0, 60)})` : r.code)
        byEntry.set(r.entryId, list)
      }
      const emailCodes = rows.filter(r => r.entryId == null)
        .map(r => (r.detail ? `${r.code}(${r.detail.slice(0, 60)})` : r.code))
      const trace: Record<string, unknown> = {
        assigned: Object.fromEntries(
          assignedEntryIds.filter(id => byEntry.has(id)).map(id => [id, byEntry.get(id)]),
        ),
        summary: Object.fromEntries(
          [...byEntry.entries()].map(([id, codes]) => [id, codes[codes.length - 1]]),
        ),
        emailCodes,
        invariantViolations: violations,
      }
      if (rows.length === 0 && violations.length === 0) return undefined
      const json = JSON.stringify(trace)
      if (json.length <= 8192) return trace
      const compact = { summary: trace.summary, emailCodes: emailCodes.slice(-40), invariantViolations: violations, truncated: true }
      return JSON.stringify(compact).length <= 8192 ? compact : { invariantViolations: violations, truncated: true }
    },
    get invariantViolations(): string[] { return violations },
  }
}
type Ledger = ReturnType<typeof createLedger>

/** content-disposition ヘッダから実ファイル名を取得（Drive経路の既存手法を全ソースへ共通化） */
function filenameFromDisposition(res: Response): string | null {
  const cd = res.headers.get('content-disposition') ?? ''
  const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i)
  if (!m) return null
  let name: string
  try { name = decodeURIComponent(m[1].trim()) } catch { name = m[1].trim() }
  // Google Driveは日本語ファイル名を生のUTF-8バイト列のままヘッダに載せることがあり、
  // fetchのヘッダ読み出し（latin1解釈）で「ã‚¢ã‚¤ã‚¹…」型の文字化けになる（実リンク検証で発見）。
  // latin1域の文字を含み日本語を含まない場合のみ latin1→UTF-8 再デコードを試し、
  // 正当なUTF-8として日本語が復元できた場合に限り置き換える
  if (/[\u0080-\u00ff]/.test(name) && !/[\u3000-\u9fff\uff00-\uffef]/.test(name)) {
    try {
      const redecoded = new TextDecoder('utf-8', { fatal: true })
        .decode(Uint8Array.from(name, c => c.charCodeAt(0) & 0xff))
      if (/[\u3000-\u9fff\uff00-\uffef]/.test(redecoded)) name = redecoded
    } catch { /* 正当なUTF-8でなければ化けていない通常のlatin1名としてそのまま */ }
  }
  return name
}

/** ゾーンA: 本文から Google 系リンクを3種類、独立に検出（ID単位で重複排除） */
function detectGoogleLinks(body: string): {
  sheets: { id: string; gid: string }[]
  docs: { id: string }[]
  drive: { id: string; index: number }[]
} {
  const sheets: { id: string; gid: string }[] = []
  const seenSheets = new Set<string>()
  for (const m of body.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{25,})[^\s]*/g)) {
    if (seenSheets.has(m[1])) continue
    seenSheets.add(m[1])
    // gid は「?gid=」「&gid=」だけでなくシートタブURLの「#gid=」（ハッシュ形式）でも指定される
    const gidMatch = m[0].match(/[?&#]gid=(\d+)/)
    sheets.push({ id: m[1], gid: gidMatch ? gidMatch[1] : '0' })
  }
  const docs: { id: string }[] = []
  const seenDocs = new Set<string>()
  for (const m of body.matchAll(/https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{25,})/g)) {
    if (seenDocs.has(m[1])) continue
    seenDocs.add(m[1])
    docs.push({ id: m[1] })
  }
  const drive: { id: string; index: number }[] = []
  const seenDrive = new Set<string>()
  for (const m of body.matchAll(/https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{25,})/g)) {
    if (seenDrive.has(m[1])) continue
    seenDrive.add(m[1])
    drive.push({ id: m[1], index: m.index ?? 0 })
  }
  return { sheets, docs, drive }
}

/**
 * gid照合用フィンガープリント: gid指定CSVを取得して2D配列化する。
 * エクスポートXLSXにはGoogleのgidが含まれないため、このCSV（=送信者が指したタブの中身）を
 * XLSX内の各シートと突き合わせて対象シートを特定する。XLSX失敗時の保険テキストも兼ねる。
 */
async function fetchCsvFingerprint(id: string, gid: string): Promise<{ rows: string[][]; raw: string } | null> {
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`)
    if (!res.ok) return null
    const raw = await res.text()
    // レート制限・権限なしのHTMLページはCSVとして扱わない
    if (/^\s*</.test(raw) || /text\/html/.test(res.headers.get('content-type') ?? '')) return null
    // 引用符内の改行・カンマ・""エスケープに対応した1パスCSVパース。
    // 行分割を先にやると「"シメイ\n氏名"」のような複数行セルが壊れてゴミセルになり、
    // gidフィンガープリント照合のスコアが実データで届かない実害があった（実リンク検証で発見）
    const rows: string[][] = []
    let cells: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < raw.length && rows.length < 200; i++) {
      const ch = raw[i]
      if (inQuote) {
        if (ch === '"') {
          if (raw[i + 1] === '"') { cur += '"'; i++ }  // "" は引用符1個
          else inQuote = false
        } else cur += ch
      } else if (ch === '"') {
        inQuote = true
      } else if (ch === ',') {
        cells.push(cur); cur = ''
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && raw[i + 1] === '\n') i++
        cells.push(cur); cur = ''
        rows.push(cells); cells = []
      } else cur += ch
    }
    if (cur !== '' || cells.length > 0) { cells.push(cur); rows.push(cells) }
    return { rows, raw }
  } catch { return null }
}

const XLSX_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const DOCX_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DRIVE_SKIP_KEYWORDS = ['ポートフォリオ', '作品集', 'portfolio', 'Portfolio']

/**
 * GoogleのエクスポートAPIはレート制限・権限なし時も HTTP 200 で HTMLページを返すため、
 * res.ok だけでは検知できない（HTMLを経歴書として保存する事故になる）。
 * xlsx/docx は zip形式＝先頭が "PK" であることを利用して実体を検証する。
 */
function looksLikeZipBytes(ab: ArrayBuffer): boolean {
  const b = new Uint8Array(ab.slice(0, 2))
  return b.length >= 2 && b[0] === 0x50 && b[1] === 0x4B
}

/** ゾーンA①: Sheetsリンク → XLSX本流（bytes保持）・CSVは照合用フィンガープリント＋保険 */
async function fetchSheetsEntry(link: { id: string; gid: string }, ledger: Ledger): Promise<SourceEntry | null> {
  const entryId = ledger.nextEntryId()
  const fp = await fetchCsvFingerprint(link.id, link.gid)
  const sourceUrl = `https://docs.google.com/spreadsheets/d/${link.id}/edit#gid=${link.gid}`
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/spreadsheets/d/${link.id}/export?format=xlsx`, 20000)
    if (res.ok) {
      const ab = await res.arrayBuffer()
      if (!looksLikeZipBytes(ab)) {
        // レート制限・権限なしのHTMLページ。catch節でA-FETCH-FAILを記録しCSV保険へフォールバック
        throw new Error('xlsxがHTML応答(レート制限/権限なし)')
      }
      const b64 = arrayBufferToBase64(ab)
      const filename = filenameFromDisposition(res) ?? `GoogleSheet_${link.id}.xlsx`
      ledger.log(entryId, 'A-XLSX-OK', `${filename} ${Math.round(b64.length * 3 / 4 / 1024)}KB`)
      return {
        entryId, label: `Googleスプレッドシート(${filename})`, content: '', filename,
        kind: 'excel', origin: 'sheets',
        attachment: { data: b64, mimeType: XLSX_EXPORT_MIME, name: filename.endsWith('.xlsx') ? filename : `${filename}.xlsx` },
        gidHint: { gid: link.gid, csvRows: fp?.rows },
        sourceUrl,
      }
    }
    ledger.log(entryId, 'A-FETCH-FAIL', `sheets xlsx status=${res.status}`)
  } catch (e) { ledger.log(entryId, 'A-FETCH-FAIL', `sheets xlsx ${e instanceof Error ? e.message : String(e)}`) }
  // 保険: CSVテキスト（旧本流・bytesなしのためStorage候補にはならない）
  if (fp && fp.raw.trim()) {
    ledger.log(entryId, 'A-CSV-FB', `sheets ${link.id}`)
    const sy = extractSkillYearsFromSheetData(fp.rows)
    return {
      entryId, label: `Googleスプレッドシート(${link.id})`, content: fp.raw,
      filename: `GoogleSheet_${link.id}.csv`, kind: 'text', origin: 'sheets',
      skillYears: Object.keys(sy).length > 0 ? sy : undefined,
      sourceUrl,
    }
  }
  return null
}

/** ゾーンA②: Docsリンク → DOCX本流（bytes保持）・txtは保険 */
async function fetchDocsEntry(link: { id: string }, ledger: Ledger): Promise<SourceEntry | null> {
  const entryId = ledger.nextEntryId()
  const sourceUrl = `https://docs.google.com/document/d/${link.id}/edit`
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/document/d/${link.id}/export?format=docx`, 20000)
    if (res.ok) {
      const ab = await res.arrayBuffer()
      if (!looksLikeZipBytes(ab)) throw new Error('docxがHTML応答(レート制限/権限なし)')
      const b64 = arrayBufferToBase64(ab)
      const filename = filenameFromDisposition(res) ?? `GoogleDoc_${link.id}.docx`
      ledger.log(entryId, 'A-DOCX-OK', filename)
      return {
        entryId, label: `Googleドキュメント(${filename})`, content: '', filename,
        kind: 'word', origin: 'docs',
        attachment: { data: b64, mimeType: DOCX_EXPORT_MIME, name: filename.endsWith('.docx') ? filename : `${filename}.docx` },
        sourceUrl,
      }
    }
    ledger.log(entryId, 'A-FETCH-FAIL', `docs docx status=${res.status}`)
  } catch (e) { ledger.log(entryId, 'A-FETCH-FAIL', `docs docx ${e instanceof Error ? e.message : String(e)}`) }
  // 保険: txtエクスポート（旧本流）
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/document/d/${link.id}/export?format=txt`, 20000)
    if (res.ok && !/text\/html/.test(res.headers.get('content-type') ?? '')) {
      ledger.log(entryId, 'A-TXT-FB', `docs ${link.id}`)
      return {
        entryId, label: `Googleドキュメント(${link.id})`, content: await res.text(),
        filename: `GoogleDoc_${link.id}.txt`, kind: 'text', origin: 'docs', sourceUrl,
      }
    }
    ledger.log(entryId, 'A-FETCH-FAIL', `docs txt status=${res.status}`)
  } catch (e) { ledger.log(entryId, 'A-FETCH-FAIL', `docs txt ${e instanceof Error ? e.message : String(e)}`) }
  return null
}

/** ゾーンA③: Drive単体ファイルリンク（旧fetchGoogleLinksのDrive経路を移植・bytesを保持） */
async function fetchDriveEntry(link: { id: string; index: number }, body: string, ledger: Ledger): Promise<SourceEntry | null> {
  // ポートフォリオ等、経歴書以外のファイルはスキップ（リンク直前150文字で判定・既存動作）
  const preceding = body.slice(Math.max(0, link.index - 150), link.index)
  if (DRIVE_SKIP_KEYWORDS.some(kw => preceding.includes(kw))) {
    ledger.log(null, 'A-SKIP-PORTFOLIO', `drive ${link.id}`)
    return null
  }
  const entryId = ledger.nextEntryId()
  const sourceUrl = `https://drive.google.com/file/d/${link.id}/view`
  try {
    const res = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${link.id}`, 20000)
    if (!res.ok) { ledger.log(entryId, 'A-FETCH-FAIL', `drive status=${res.status}`); return null }
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (ct === 'text/html') {
      // レート制限・権限なし・ウイルススキャン確認ページ等。HTMLをテキスト経歴書として取り込まない
      ledger.log(entryId, 'A-FETCH-FAIL', 'driveがHTML応答(レート制限/権限/確認ページ)')
      return null
    }
    const filename = filenameFromDisposition(res) ?? `drive_${link.id}`
    const isExcel = EXCEL_MIME.includes(ct) || ct.includes('spreadsheet') || ct.includes('excel') || /\.(xls[xmb]?|ods)$/i.test(filename)
    const isWord = WORD_MIME.includes(ct) || ct.includes('msword') || ct.includes('wordprocessingml') || /\.(doc[xm]?)$/i.test(filename)
    const isPdf = ct.includes('pdf') || /\.pdf$/i.test(filename)
    if (isPdf) {
      const b64 = arrayBufferToBase64(await res.arrayBuffer())
      ledger.log(entryId, 'A-DRIVE-OK', `pdf ${filename}`)
      return { entryId, label: `Drive PDF(${filename})`, content: '', filename, kind: 'pdf', origin: 'drive', attachment: { data: b64, mimeType: 'application/pdf', name: filename }, sourceUrl }
    }
    if (ct.includes('text') || ct.includes('csv')) {
      ledger.log(entryId, 'A-DRIVE-OK', `text ${filename}`)
      return { entryId, label: `Driveファイル(${filename})`, content: await res.text(), filename, kind: 'text', origin: 'drive', sourceUrl }
    }
    if (isExcel || isWord) {
      const b64 = arrayBufferToBase64(await res.arrayBuffer())
      ledger.log(entryId, 'A-DRIVE-OK', `${isExcel ? 'excel' : 'word'} ${filename}`)
      return {
        entryId, label: `Drive ${isExcel ? 'Excel' : 'Word'}(${filename})`, content: '', filename,
        kind: isExcel ? 'excel' : 'word', origin: 'drive',
        attachment: { data: b64, mimeType: ct || (isExcel ? XLSX_EXPORT_MIME : DOCX_EXPORT_MIME), name: filename },
        sourceUrl,
      }
    }
    ledger.log(entryId, 'A-FETCH-FAIL', `drive 未対応タイプ(${ct}) ${filename}`)
    return null
  } catch (e) {
    ledger.log(entryId, 'A-FETCH-FAIL', `drive ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * ゾーンB: gidフィンガープリント照合 — CSV（送信者が指したタブ）の先頭セル群と
 * XLSX各シートの先頭グリッドを突き合わせ、一致したシート名を返す。
 * 8割以上一致した場合のみ認定（偶然一致の誤爆防止）。照合不能なら null（キーワードソートに落ちる）。
 */
function matchSheetByFingerprint(
  sheetHeads: { name: string; head: string[][] }[],
  csvRows: string[][],
): string | null {
  const fpCells = csvRows.slice(0, 5).flat().map(c => c.trim()).filter(c => c.length >= 2).slice(0, 20)
  if (fpCells.length < 3) return null
  let best: { name: string; score: number } | null = null
  for (const sheet of sheetHeads) {
    const sheetCells = new Set(sheet.head.flat().map(c => (c ?? '').trim()).filter(Boolean))
    const score = fpCells.filter(c => sheetCells.has(c)).length
    if (score > (best?.score ?? 0)) best = { name: sheet.name, score }
  }
  return best && best.score >= Math.ceil(fpCells.length * 0.8) ? best.name : null
}

/** ゾーンB: kind別ディスパッチ — bytesを持つエントリを2関数（extractExcelAll/extractWordText）で抽出 */
async function extractEntry(entry: SourceEntry, ledger: Ledger): Promise<SourceEntry> {
  if (!entry.attachment?.data) return entry
  if (entry.kind === 'excel') {
    const { text, skillYears, jsonRows, skillSummary, parseError, grid, links, sheetPickedBy } =
      await extractExcelAll(entry.attachment.data, { gidCsvRows: entry.gidHint?.csvRows })
    if (sheetPickedBy === 'gid') ledger.log(entry.entryId, 'B-SHEET-GID')
    if (parseError) ledger.log(entry.entryId, 'B-PARSE-ERR', parseError.slice(0, 80))
    else ledger.log(entry.entryId, text.trim() ? 'B-EXTRACT-OK' : 'B-EXTRACT-EMPTY', `t=${text.length} sy=${Object.keys(skillYears).filter(k => !k.startsWith('_')).length}`)
    // どの抽出Methodがスキル年数を出したか（10=列型 15=項番 16=複数年数列 17=KVブロック 20=近接探索 30=数値一覧）。
    // pipeline_trace に残り、「Method 2（最後の受け皿）比率の上昇=上流の劣化」を後から観測できる
    if (typeof skillYears['_extractMethod'] === 'number') {
      ledger.log(entry.entryId, 'B-SY-METHOD', `M${skillYears['_extractMethod']}`)
    }
    if (links && links.length > 0) ledger.log(entry.entryId, 'B-LINKS', `${links.length}件`)
    return {
      ...entry, content: text,
      skillYears: Object.keys(skillYears).length > 0 ? skillYears : undefined,
      jsonRows: jsonRows && jsonRows.length > 0 ? jsonRows : undefined,
      skillSummary, grid, links,
    }
  }
  if (entry.kind === 'word') {
    const { text: rawText, totalProjectMonths, skillYears, grid, links } = await extractWordText(entry.attachment.data)
    const text = rawText.trim() ? cleanseWordText(rawText) : ''
    ledger.log(entry.entryId, text ? 'B-EXTRACT-OK' : 'B-EXTRACT-EMPTY', `t=${text.length}`)
    if (typeof skillYears?.['_extractMethod'] === 'number') {
      ledger.log(entry.entryId, 'B-SY-METHOD', `M${skillYears['_extractMethod']}`)
    }
    if (links && links.length > 0) ledger.log(entry.entryId, 'B-LINKS', `${links.length}件`)
    return { ...entry, content: text, totalProjectMonths, skillYears, grid, links }
  }
  if (entry.kind === 'pdf') {
    const pdfText = await extractPdfText(entry.attachment.data)
    ledger.log(entry.entryId, pdfText.trim() ? 'B-EXTRACT-OK' : 'B-EXTRACT-EMPTY', `pdf t=${pdfText.length}`)
    return { ...entry, content: pdfText.slice(0, 8000) }
  }
  return entry
}

/** ゾーンA+B: 本文中のGoogle系リンクを統一エントリとして取得・抽出するオーケストレータ */
async function collectGoogleEntries(body: string, ledger: Ledger): Promise<SourceEntry[]> {
  const links = detectGoogleLinks(body)
  const out: SourceEntry[] = []
  for (const s of links.sheets) {
    const e = await fetchSheetsEntry(s, ledger)
    if (e) out.push(await extractEntry(e, ledger))
  }
  for (const d of links.docs) {
    const e = await fetchDocsEntry(d, ledger)
    if (e) out.push(await extractEntry(e, ledger))
  }
  for (const dr of links.drive) {
    const e = await fetchDriveEntry(dr, body, ledger)
    if (e) out.push(await extractEntry(e, ledger))
  }
  return out
}

/**
 * 名簿の氏名列の値として妥当か。
 * 縦型経歴書ではラベル列（生年月日/学歴/期間/作業概要…）や日付・技術用語が
 * 「氏名」と同じ列に並ぶため、これらを人名と誤認すると経歴書1枚を名簿と誤検出し、
 * ゴミ候補者（「要件定義」「1989年4月」等）を大量登録する実害があった（ローカルテストで検出）。
 */
function looksLikeRosterName(s: string): boolean {
  const t = s.trim()
  if (t.length < 1 || t.length > 25) return false
  // 経歴書・スキルシートの見出し語/セクション語は人名ではない
  if (/生年月日|年月日|学歴|学　*歴|住所|住　*所|期間|概要|案件|要件|作業|工程|役割|人数|規模|環境|備考|資格|スキル|言語|OS\b|フレームワーク|ツール|自己PR|経験|年数|性別|年齢|最寄|駅|単価|金額|稼働|開始|終了|合計|小計|通勤|沿線|会社|所属|部署|電話|メール|mail|TEL|FAX|プロジェクト|システム|開発|設計|テスト|運用|保守|担当|内容|詳細|日付|時期|現在|以上|以下|合否|評価|№|No\.?|保有|得意|分野|技術|職種|職務|要約|サマリ|紹介|実績|成果|履歴/i.test(t)) return false
  // スキルシートのカテゴリ見出し（データベース/ネットワーク等のカタカナ分類語）は人名ではない。
  // 1人分のスキルシートを名簿と誤検出し、分類セルを人名行として展開する事故を防ぐ（Y.M_沼津.xlsx 実害）
  if (/^(?:データベース|ネットワーク|サーバ(?:ー)?|ミドルウェア|インフラ(?:ストラクチャ)?|クラウド|セキュリティ|ストレージ|プラットフォーム|アプリケーション|オペレーティングシステム|ハードウェア|ソフトウェア|プログラミング|マネジメント|コミュニケーション|プログラム|アーキテクチャ)$/.test(t)) return false
  // 日付・数字始まり（1989年4月、2026/05 等）は人名ではない
  if (/^[\d０-９(（]/.test(t)) return false
  // 英字1単語3文字以上（Unix/PHP/Mysql/Apa等の技術用語）は除外。
  // イニシャル（A.M / K.T / OH）とスペース区切りローマ字（Tanaka Taro）は許容
  if (/^[A-Za-z]{3,}$/.test(t)) return false
  return true
}

/**
 * ゾーンC: 名簿判定 — このエントリは複数人分の名簿か。
 * 1) グリッド型: 名簿ヘッダ行（氏名列+年齢/駅/単価等のヘッダ語）があり、人名らしい行が2行以上。
 *    セル参照の行番号からその行のハイパーリンクも対応付ける（リンク型名簿の基盤）。
 * 2) テキスト型: 【氏名】等のラベル組が2セット以上。
 */
function detectRoster(entry: SourceEntry): { isRoster: boolean; rows: { name: string; rowText: string; links: { cell: string; url: string }[] }[] } {
  if (entry.grid && entry.grid.length >= 3) {
    const NAME_COL_RE = /^(?:氏\s*名|名\s*前|イニシャル|お名前|姓名)$/
    // 名簿のヘッダ行に氏名と並んで現れる典型的な列名。
    // 縦型経歴書では「氏名」セルの右隣は本人の氏名の値（人名）なのでこれに一致せず、
    // 経歴書のラベル列を名簿ヘッダと誤認するのを防ぐ
    const ROSTER_HEADER_HINT_RE = /年齢|性別|最寄|駅|単価|金額|希望|経験|年数|スキル|稼働|時期|所属|国籍|勤務|備考|リンク|URL|経歴書|レジュメ|エリア|地域|区分|状況|ステータス/
    for (let h = 0; h < Math.min(5, entry.grid.length); h++) {
      const headerRow = entry.grid[h]
      const nameCol = headerRow.findIndex(c => NAME_COL_RE.test((c ?? '').trim()))
      if (nameCol === -1) continue
      // ヘッダ行検証: 氏名セルと同じ行に名簿ヘッダらしい列名が1つ以上無ければ名簿ではない
      const headerHints = headerRow.filter((c, i) => i !== nameCol && ROSTER_HEADER_HINT_RE.test(c ?? ''))
      if (headerHints.length < 1) continue
      const dataRows: { name: string; rowText: string; links: { cell: string; url: string }[] }[] = []
      // 名簿の人材行はヘッダ直下に連続して並ぶ。空行・無効行が3行続いたら表の終わりとみなす。
      // 1人用プロフィール表（氏名+年齢+駅ヘッダ）の列のはるか下にある無関係セル
      // （実例: OH.xlsxのイニシャルセル）を別の人材行として拾う誤検出を防ぐ
      let gapRows = 0
      for (let r = h + 1; r < entry.grid.length; r++) {
        if (gapRows >= 3 && dataRows.length > 0) break
        const row = entry.grid[r]
        const name = (row[nameCol] ?? '').trim()
        if (!name || name.length > 30) { gapRows++; continue }
        if (!looksLikeRosterName(name)) { gapRows++; continue }
        const otherCells = row.filter((c, i) => i !== nameCol && (c ?? '').trim().length > 0)
        if (otherCells.length < 2) { gapRows++; continue }
        gapRows = 0
        const rowText = headerRow.map((hc, i) => {
          const v = (row[i] ?? '').trim()
          return (hc ?? '').trim() && v ? `【${hc.trim().slice(0, 12)}】${v}` : null
        }).filter(Boolean).join('\n')
        // セル参照 "G8" の行番号（1-based）= グリッドindex+1 でリンクを行に対応付け
        const rowLinks = (entry.links ?? []).filter(l => {
          const m = l.cell.match(/(\d+)$/)
          return m ? Number(m[1]) === r + 1 : false
        })
        dataRows.push({ name, rowText, links: rowLinks })
      }
      if (dataRows.length >= 2) return { isRoster: true, rows: dataRows }
    }

    // グリッド型②: サマリー列名簿 — 「氏名」ヘッダ列が無く、1つの列に【氏名】：I.S 形式の
    // サマリーセルが縦に並ぶ形式（実例: アイスタンダード注力フリーランス一覧・117人）。
    // グリッドはテキストと違い文字数上限で切り詰められないため全行を検出でき、
    // 行番号からスキルシート列のハイパーリンクとも対応付けられる（リンク型名簿の基盤）
    {
      const globalNameReG = new RegExp(MULTI_NAME_FIELD_RE.source, 'm')
      const trySummaryRoster = (
        grid: string[][],
        links: { cell: string; url: string }[],
      ): { name: string; rowText: string; links: { cell: string; url: string }[] }[] | null => {
        const colCount = Math.max(...grid.map(r => r.length), 0)
        let best: { col: number; rows: number[] } | null = null
        for (let c = 0; c < colCount; c++) {
          const rowIdxs: number[] = []
          for (let r = 0; r < grid.length; r++) {
            const cell = (grid[r][c] ?? '').trim()
            if (cell.length >= 30 && globalNameReG.test(cell) && MULTI_CANDIDATE_FIELD_RE.test(cell)) rowIdxs.push(r)
          }
          if (rowIdxs.length >= 2 && rowIdxs.length > (best?.rows.length ?? 0)) best = { col: c, rows: rowIdxs }
        }
        if (!best) return null
        // ヘッダ行（先頭行に短い列名が2つ以上並ぶ場合）を行テキストのラベルに使う
        const headerRow = grid[0] ?? []
        const hasHeader = headerRow.filter(c => { const t = (c ?? '').trim(); return t.length > 0 && t.length <= 15 }).length >= 2
          && !best.rows.includes(0)
        const dataRows: { name: string; rowText: string; links: { cell: string; url: string }[] }[] = []
        for (const r of best.rows) {
          const summaryCell = (grid[r][best.col] ?? '').trim()
          // 「【氏名】：I.S」形式ではラベル後の「：」まで名前として拾われるため先頭の区切りを除去
          const name = (extractNameFallback(summaryCell) ?? '').replace(/^[：:\s　]+/, '')
          if (!name || !looksLikeRosterName(name)) continue
          const otherFields = grid[r].map((v, i) => {
            if (i === best!.col) return null
            const val = (v ?? '').trim()
            if (!val) return null
            const label = hasHeader ? (headerRow[i] ?? '').trim().slice(0, 12) : ''
            return label ? `【${label}】${val}` : val
          }).filter(Boolean).join('\n')
          const rowLinks = links.filter(l => {
            const m = l.cell.match(/(\d+)$/)
            return m ? Number(m[1]) === r + 1 : false
          })
          dataRows.push({ name, rowText: [otherFields, summaryCell].filter(Boolean).join('\n'), links: rowLinks })
        }
        const distinct = new Set(dataRows.map(x => x.name.replace(/[.\s　・]/g, '').toLowerCase()))
        return dataRows.length >= 2 && distinct.size >= 2 ? dataRows : null
      }

      // 行方向（人が行に並ぶ・リンクは同じ行）を先に試す
      const rowWise = trySummaryRoster(entry.grid, entry.links ?? [])
      if (rowWise) return { isRoster: true, rows: rowWise }

      // フォールバック: 転置して列方向（人が列に並ぶ・リンクは同じ列）。
      // グリッドを転置し、リンクのセル番地は「列」を疑似行番号（T<列index+1>）へ変換することで
      // 行方向と完全に同じアルゴリズム・同じガードを通す
      const maxCols = Math.max(...entry.grid.map(r => r.length), 0)
      if (maxCols >= 3 && entry.grid.length >= 2) {
        const tGrid: string[][] = Array.from({ length: maxCols }, (_, c) =>
          entry.grid!.map(row => row[c] ?? ''))
        const tLinks = (entry.links ?? []).map(l => {
          const ci = colIndexFromCellRef(l.cell)
          return ci >= 0 ? { cell: `T${ci + 1}`, url: l.url } : null
        }).filter((x): x is { cell: string; url: string } => x !== null)
        const colWise = trySummaryRoster(tGrid, tLinks)
        if (colWise) return { isRoster: true, rows: colWise }
      }
    }
  }
  // テキスト型（splitMultiCandidateBody と同じ氏名・フィールド判定を流用）。
  // 判定は「同一シート内」で行う: 1人分の経歴書ワークブックは履歴書シートと経歴書シートの
  // 両方に氏名が書かれており、シートを跨いで数えると同一人物を2人の名簿と誤認して
  // 重複登録する実害があった（実例: OH.xlsx = 氏名:OH + 氏名:小日向 秀樹 は同一人物）
  const globalNameRe = new RegExp(MULTI_NAME_FIELD_RE.source, 'gm')
  const sections = entry.content.split(/^--- シート: [^\n]+ ---$/m)
  for (const section of sections) {
    const nameMatches = [...section.matchAll(globalNameRe)]
    if (nameMatches.length < 2) continue
    const rows: { name: string; rowText: string; links: { cell: string; url: string }[] }[] = []
    for (let i = 0; i < nameMatches.length; i++) {
      const start = nameMatches[i].index ?? 0
      const end = i + 1 < nameMatches.length ? (nameMatches[i + 1].index ?? section.length) : section.length
      const seg = section.slice(start, end).trim()
      if (seg.length < 30 || !MULTI_CANDIDATE_FIELD_RE.test(seg)) continue
      const name = (extractNameFallback(seg) ?? '').replace(/^[：:\s　]+/, '')
      if (!name || !looksLikeRosterName(name)) continue
      rows.push({ name, rowText: seg, links: [] })
    }
    // 相異なる氏名が2人以上いて初めて名簿。1人の経歴書は表紙と本文などで同じ氏名ラベルが
    // 2回出ることが多く（実例: 実DOCXで同一人物が2候補者に分裂した）、同名のみなら単票扱い
    const distinctNames = new Set(rows.map(r => r.name.replace(/[.\s　・]/g, '').toLowerCase()))
    if (rows.length >= 2 && distinctNames.size >= 2) return { isRoster: true, rows }
  }
  return { isRoster: false, rows: [] }
}

/** セル参照 "G14" / "AA3" の列文字を0始まりの列indexへ変換（転置名簿のリンク対応付け用） */
function colIndexFromCellRef(cell: string): number {
  const m = cell.match(/^([A-Za-z]+)/)
  if (!m) return -1
  let n = 0
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** ゾーンC: 名簿行内のリンク先を再取得する。深さ1で打ち切り（名簿の名簿は展開しない） */
async function fetchLinkedResume(url: string, ledger: Ledger, depth: number): Promise<SourceEntry | null> {
  if (depth >= 1) {
    ledger.log(null, 'C-DEPTH-CUT', url.slice(0, 60))
    return null
  }
  const links = detectGoogleLinks(url)
  let fetched: SourceEntry | null = null
  if (links.sheets[0]) fetched = await fetchSheetsEntry(links.sheets[0], ledger)
  else if (links.docs[0]) fetched = await fetchDocsEntry(links.docs[0], ledger)
  else if (links.drive[0]) fetched = await fetchDriveEntry({ id: links.drive[0].id, index: 0 }, '', ledger)
  if (!fetched) return null
  return await extractEntry(fetched, ledger)
}

/** 名簿1個から展開する行数の上限（異常に大きい名簿による処理爆発の防止） */
const ROSTER_MAX_ROWS = 15

/**
 * ゾーンC: 名簿判定・行展開のオーケストレータ。
 * 名簿は行ごとに独立エントリへ展開してから返す（「1エントリ=1人」を下流に保証する）。
 * リンク型の行はリンク先を再取得して本人エントリに差し替える（Google系のみ・深さ1）。
 */
/** 名簿1通あたりのリンク先取得に使える時間予算（ms）。超過後の行は埋め込み型に降格して継続 */
const ROSTER_LINK_FETCH_BUDGET_MS = 60_000

async function expandRosterEntries(entries: SourceEntry[], ledger: Ledger, linkBudgetMs = ROSTER_LINK_FETCH_BUDGET_MS, priorityNames: string[] = []): Promise<SourceEntry[]> {
  const linkFetchStart = Date.now()
  const out: SourceEntry[] = []
  // 本文で紹介されている人材の行を先頭へ（安定ソート）。
  // 15行上限・リンク取得60秒予算は先頭から消費されるため、並べ替えないと
  // 「本文に名前がある人が名簿の16行目以降にいる」場合に行情報とリンク先経歴書ごと失われる。
  const normName = (s: string) => s.replace(/[.\s　・]/g, '').toLowerCase()
  const priNorms = priorityNames.map(normName).filter(n => n.length >= 2)
  const isPriority = (rowName: string) => {
    const rn = normName(rowName)
    return rn.length >= 2 && priNorms.some(p => p.includes(rn) || rn.includes(p))
  }
  for (const entry of entries) {
    const roster = detectRoster(entry)
    if (!roster.isRoster) {
      out.push(entry)
      continue
    }
    ledger.log(entry.entryId, 'C-ROSTER', `${roster.rows.length}行に展開`)
    let orderedRows = roster.rows
    if (priNorms.length > 0) {
      const pri = roster.rows.filter(r => isPriority(r.name))
      if (pri.length > 0) {
        orderedRows = [...pri, ...roster.rows.filter(r => !isPriority(r.name))]
        ledger.log(entry.entryId, 'C-ROSTER-PRI', `本文人材${pri.length}人の行を優先`)
      }
    }
    if (orderedRows.length > ROSTER_MAX_ROWS) ledger.log(entry.entryId, 'C-ROSTER-CAP', `${orderedRows.length}→${ROSTER_MAX_ROWS}`)
    for (const row of orderedRows.slice(0, ROSTER_MAX_ROWS)) {
      const rowEntryId = ledger.nextEntryId()
      let rowEntry: SourceEntry = {
        entryId: rowEntryId, parentId: entry.entryId,
        label: `${entry.label}#${row.name}`, content: row.rowText,
        filename: entry.filename, kind: 'text', origin: entry.origin,
        rosterRowName: row.name, sourceUrl: entry.sourceUrl,
      }
      const googleLink = row.links.find(l => /docs\.google\.com|drive\.google\.com/.test(l.url))
      if (googleLink && Date.now() - linkFetchStart >= linkBudgetMs) {
        // Edge Functionのワーカー時間制限対策: 予算超過後の行はリンク先を取得せず
        // 行テキストの埋め込みで登録を継続する（登録漏れよりリンク先情報の欠落を選ぶ）
        ledger.log(rowEntryId, 'C-ROW-LINK-SKIP', `リンク取得予算(${Math.round(linkBudgetMs / 1000)}s)超過`)
        rowEntry.content += `\n${googleLink.url}`
        out.push(rowEntry)
        continue
      }
      if (googleLink) {
        const linked = await fetchLinkedResume(googleLink.url, ledger, 0)
        // リンク先の氏名検証: 取得した経歴書のファイル名+中身に本人の氏名/イニシャルが
        // 見えなければ採用しない（行ズレ・転置判定ミス等で他人の経歴書を紐づける事故の
        // 最終防衛線。誤った紐づけより無しの方が安全）。見送った行は埋め込みで登録継続
        const rowNorm = row.name.replace(/[.\s　・]/g, '').toLowerCase()
        const linkedHay = linked ? `${linked.filename}\n${linked.content}`.replace(/[.\s　・]/g, '').toLowerCase() : ''
        if (linked && rowNorm.length >= 2 && !linkedHay.includes(rowNorm)) {
          ledger.log(rowEntryId, 'C-ROW-LINK-REJ', `リンク先に氏名(${row.name})が見当たらないため採用見送り`)
          rowEntry.content += `\n${googleLink.url}`
        } else if (linked) {
          ledger.log(rowEntryId, 'C-ROW-LINK-OK', googleLink.url.slice(0, 60))
          rowEntry = {
            ...linked,
            entryId: rowEntryId, parentId: entry.entryId,
            label: `${entry.label}#${row.name}`,
            content: `${row.rowText}\n${linked.content}`,
            rosterRowName: row.name,
          }
          // リンク先自体が名簿でも展開しない（深さ1・1人分として扱う）
          if (detectRoster(rowEntry).isRoster) ledger.log(rowEntryId, 'C-DEPTH-CUT', 'リンク先も名簿構造だが展開しない')
        } else {
          ledger.log(rowEntryId, 'C-ROW-LINK-FAIL', googleLink.url.slice(0, 60))
        }
      } else {
        // Box等の認証必須リンクはダウンロードせず、行テキストに残して既存のextractBoxUrlsに拾わせる
        const nonGoogle = row.links[0]
        if (nonGoogle) rowEntry.content += `\n${nonGoogle.url}`
        ledger.log(rowEntryId, 'C-ROW-EMBED', row.name)
      }
      out.push(rowEntry)
    }
  }
  return out
}

/**
 * ゾーンD: 単一人材メール用の氏名照合ゲート。
 * 現行は単一人材だと検証なしで全エントリが本人に紐づいていた（F.Kさん事故の構造的原因）。
 * 誤った紐づけをするより紐づけ無しの方が安全、の方針で選別する。
 */
function gateSingleCandidate(
  meta: { name: string | null },
  entries: SourceEntry[],
  ledger: Ledger,
): { assigned: SourceEntry[]; rejected: SourceEntry[] } {
  const myNorm = (meta.name ?? '').replace(/[.\s　・]/g, '').toLowerCase()
  if (myNorm.length < 2) {
    if (entries.length > 0) ledger.log(null, 'D-GATE-NONAME', '本文から氏名が取れないため全エントリを許可（従来動作）')
    return { assigned: entries, rejected: [] }
  }
  const assigned: SourceEntry[] = []
  const neutral: SourceEntry[] = []
  const rejected: SourceEntry[] = []
  for (const e of entries) {
    const hay = `${e.filename}\n${e.content}`.toLowerCase().replace(/[.・]/g, '')
    if (hay.includes(myNorm)) {
      assigned.push(e)
      ledger.log(e.entryId, 'D-GATE-OK')
      continue
    }
    // 名簿行由来で行の氏名が別人 → 明確に他人のデータなので本人に紐づけない
    if (e.rosterRowName) {
      const rowNorm = e.rosterRowName.replace(/[.\s　・]/g, '').toLowerCase()
      if (rowNorm.length >= 2 && rowNorm !== myNorm) {
        rejected.push(e)
        ledger.log(e.entryId, 'D-GATE-REJ', `他人の名簿行:${e.rosterRowName}`)
        continue
      }
    }
    neutral.push(e)
  }
  // 氏名シグナルの無いエントリ（汎用ファイル名・氏名レス経歴書）は従来動作を維持して許可する。
  // 明確に他人と判定されたもの（rejected）だけを除外する安全側の縮小。
  if (neutral.length > 0) {
    assigned.push(...neutral)
    ledger.log(null, 'D-GATE-ALL', `氏名シグナルなし${neutral.length}件を許可`)
  }
  return { assigned, rejected }
}

/**
 * ゾーンD: 名簿にしか載っていない人材を新規候補者ブロックとして起こす。
 * 既存ブロックの氏名と一致しない名簿行エントリの行テキストを返す（本文ブロックと同じ検証・dedupを通す）。
 */
function promoteUnassignedRosterEntries(
  rosterEntries: SourceEntry[],
  existingBlockNames: (string | null)[],
  ledger: Ledger,
): { name: string; rowText: string }[] {
  const norm = (s: string) => s.replace(/[.\s　・]/g, '').toLowerCase()
  const known = new Set(existingBlockNames.filter((n): n is string => !!n).map(norm))
  const out: { name: string; rowText: string }[] = []
  for (const e of rosterEntries) {
    if (!e.rosterRowName) continue
    const n = norm(e.rosterRowName)
    if (n.length < 2 || known.has(n)) continue
    known.add(n)
    ledger.log(e.entryId, 'D-NEWBLOCK', e.rosterRowName)
    out.push({ name: e.rosterRowName, rowText: e.content })
  }
  return out
}

/** 本文中の Google URL から経歴書リンク候補を1つ選ぶ（ゾーンEでは保険に降格・旧ロジック移植） */
function pickBodyResumeLink(body: string): string | null {
  const GOOGLE_URL_RE = /https:\/\/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/(?:spreadsheets|document)\/d\/)[^\s<>"'）\]]+/gi
  const allGoogleUrls = [...body.matchAll(GOOGLE_URL_RE)].map(m => ({ url: m[0], index: m.index ?? 0 }))
  if (allGoogleUrls.length === 0) return null
  const RESUME_KEYWORDS = ['スキルシート', '職務経歴書', '経歴書', 'レジュメ', 'resume', 'スキル']
  for (const kw of RESUME_KEYWORDS) {
    const kwIdx = body.toLowerCase().indexOf(kw.toLowerCase())
    if (kwIdx === -1) continue
    const nearby = allGoogleUrls.find(u => u.index >= kwIdx && u.index <= kwIdx + 200)
    if (nearby) return nearby.url
  }
  return allGoogleUrls.find(u => u.url.includes('spreadsheets'))?.url ?? allGoogleUrls[0].url
}

/**
 * ゾーンE: resume_url の決定（優先順位を反転）。
 * 本人に割り当てられた解析済みファイルの Storage URL が最優先。本文リンクは何も無い場合の保険。
 * 旧実装は本文リンクがあると正しくパースされた添付のアップロード自体をスキップしていた（F.Kさん実害）。
 */
async function resolveResumeUrl(
  assigned: SourceEntry[],
  rawAttachments: Attachment[],
  bodyResumeLink: string | null,
  candName: string | null,
  ledger: Ledger,
): Promise<string | null> {
  const uploadOne = async (name: string | undefined, mimeType: string, data: string, entryId: number | null): Promise<string | null> => {
    const ext = (name ?? 'bin').split('.').pop() ?? 'bin'
    // 内容ハッシュベースの安定名（再処理での重複複製を防ぐ・stableResumeName のコメント参照）
    const safeName = await stableResumeName(candName ?? 'cand', data, ext)
    const url = await uploadToStorage(safeName, mimeType, data)
    if (url) ledger.log(entryId, 'E-STO-OK', safeName)
    else ledger.log(entryId, 'E-STO-FAIL', name ?? '')
    return url
  }
  for (const e of assigned) {
    if (!e.attachment?.data) continue
    const url = await uploadOne(e.attachment.name ?? e.filename, e.attachment.mimeType, e.attachment.data, e.entryId)
    if (url) { ledger.log(e.entryId, 'E-URL-STORAGE'); return url }
  }
  // 保険: 解析対象にならなかった添付（テキスト層なしのスキャンPDF等）も旧動作どおりStorage候補にする
  for (const att of rawAttachments) {
    const isOffice = EXCEL_MIME.includes(att.mimeType) || WORD_MIME.includes(att.mimeType)
      || /\.(xlsx?|xls|docx?|ods|csv)$/i.test(att.name ?? '')
    const isPdf = att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.name ?? '')
    if ((!isOffice && !isPdf) || !att.data) continue
    const url = await uploadOne(att.name, att.mimeType, att.data, null)
    if (url) { ledger.log(null, 'E-URL-STORAGE', '未解析添付フォールバック'); return url }
  }
  if (bodyResumeLink) {
    // 解析済みファイルがあるのに本文リンクへ落ちるのは Storage 失敗時のみ（設計上の不変条件）
    if (assigned.some(e => e.attachment?.data)) ledger.violate('INV-E-BODYLINK-SKIP', 'Storage失敗により本文リンクへフォールバック')
    ledger.log(null, 'E-URL-BODYLINK', bodyResumeLink.slice(0, 60))
    return bodyResumeLink
  }
  ledger.log(null, 'E-URL-NONE')
  return null
}

/** ゾーンE: skillYears を本人に割り当てられたエントリからのみ採用（旧driveSheetSkillYears無条件上書きの廃止） */
function pickSkillYears(assigned: SourceEntry[], ledger: Ledger): Record<string, number> {
  for (const e of assigned) {
    const sy = e.skillYears ?? {}
    if (Object.keys(sy).filter(k => !k.startsWith('_')).length > 0) {
      ledger.log(e.entryId, 'E-SY-FROM')
      return { ...sy }
    }
  }
  for (const e of assigned) {
    const sy = e.skillYears ?? {}
    if (Object.keys(sy).length > 0) {
      ledger.log(e.entryId, 'E-SY-FROM', '内部キーのみ')
      return { ...sy }
    }
  }
  for (const e of assigned) {
    if (e.totalProjectMonths && e.totalProjectMonths > 0) {
      ledger.log(e.entryId, 'E-SY-FROM', 'word月数')
      return { _totalProjectMonths: e.totalProjectMonths }
    }
  }
  return {}
}

/** HTMLタグを除去してプレーンテキストに変換 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    // テーブルセル: </td> / </th> はタブ区切り、</tr> は改行
    // → 「氏名：田中」形式のHTMLテーブルでラベルと値が正しく分離される
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&#8203;/g, '')   // zero-width space
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\t{2,}/g, '\t')  // 連続タブを1つに
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Supabase Storage アップロード ────────────────────────────────────────

/**
 * ファイルを Supabase Storage の attachments バケットにアップロードし、公開URLを返す
 */
async function uploadToStorage(
  filename: string,
  mimeType: string,
  dataB64: string,
): Promise<string | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('[Storage Upload] SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定')
    return null
  }
  try {
    const fileBytes = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0))
    // Storage キーに使えない文字（日本語・スペース・括弧等）を除去
    const safeFilename = filename.replace(/[^\w.\-]/g, '_').replace(/_+/g, '_')
    const path = `resumes/${safeFilename}`
    const client = createClient(supabaseUrl, serviceRoleKey)
    const { error } = await client.storage
      .from('attachments')
      .upload(path, fileBytes, { contentType: mimeType, upsert: true })
    if (error) {
      console.error(`[Storage Upload] アップロード失敗: ${error.message}`)
      return null
    }
    const { data: urlData } = client.storage.from('attachments').getPublicUrl(path)
    const publicUrl = urlData.publicUrl
    return publicUrl
  } catch (e) {
    console.error('[Storage Upload] 例外:', e)
    return null
  }
}

// ── Box URL 連携 ──────────────────────────────────────────────────────────

/** メール本文から Box 共有URLを抽出する */
function extractBoxUrls(body: string): string[] {
  const matches = body.matchAll(/https?:\/\/(?:[\w-]+\.)?box\.com\/s\/[\w-]+/g)
  return [...new Set([...matches].map(m => m[0]))]
}

/**
 * Google サービスアカウント JSON から OAuth2 アクセストークンを取得する（RS256 JWT）
 * Deno の crypto.subtle を使用するため Node.js の crypto 不要
 */
async function getGoogleAccessToken(
  sa: { client_email: string; private_key: string },
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const encodeBase64Url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const headerB64 = encodeBase64Url({ alg: 'RS256', typ: 'JWT' })
  const payloadB64 = encodeBase64Url({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })
  const signingInput = `${headerB64}.${payloadB64}`

  // PEM → DER 変換
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  const derBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    derBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput),
  )
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const jwt = `${signingInput}.${signatureB64}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!tokenRes.ok) {
    throw new Error(`Google OAuthトークン取得失敗: ${tokenRes.status} ${await tokenRes.text()}`)
  }
  const tokenData = (await tokenRes.json()) as { access_token: string }
  return tokenData.access_token
}

/**
 * Box URL を Googleスプレッドシートの boxurl 列（A列）に追記する
 * 失敗してもメイン処理には影響させない（try/catch で握りつぶす）
 */
async function appendToBoxSpreadsheet(boxUrls: string[]): Promise<void> {
  if (boxUrls.length === 0) return
  const spreadsheetId = Deno.env.get('BOX_SPREADSHEET_ID')
  const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!spreadsheetId || !saJson) {
    console.warn('[BoxSheet] BOX_SPREADSHEET_ID または GOOGLE_SERVICE_ACCOUNT_JSON が未設定のためスキップ')
    return
  }
  try {
    let sa: { client_email: string; private_key: string }
    try {
      sa = JSON.parse(saJson) as { client_email: string; private_key: string }
    } catch {
      console.error('[BoxSheet] GOOGLE_SERVICE_ACCOUNT_JSON が有効なJSONではありません。Supabase Secretsに正しいサービスアカウントJSONを登録してください。')
      return
    }
    const accessToken = await getGoogleAccessToken(sa, 'https://www.googleapis.com/auth/spreadsheets')
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:A:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: boxUrls.map((u) => [u]) }),
    })
    if (!res.ok) {
      console.error('[BoxSheet] スプレッドシート書き込みエラー', res.status, await res.text())
    }
  } catch (e) {
    console.error('[BoxSheet] スプレッドシート書き込み例外:', e)
  }
}

/** SHA-256 を16進文字列で返す */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Storage 保存用の安定ファイル名を生成する。
 * ファイル名の一意部分に「アップロード時刻(Date.now)」ではなく「ファイル内容のSHA-256」を使う。
 *  - 同一内容を再処理した場合 → 同じハッシュ = 同じパス = upsert で上書き（重複ファイルを作らない）
 *  - 別内容（同姓同名の別人など）→ 違うハッシュ = 別パス（衝突して上書きし合う事故を防ぐ）
 * これにより「poll-email の再処理ループで同じ添付が別名で大量複製される」問題と、
 * 「同名衝突で別人のファイルを上書きする」問題を同時に防ぐ。
 * @param prefix 人が読める接頭辞（候補者名や駅名など。無くても正しく動作する）
 * @param dataB64 添付本体（base64）。ハッシュ計算の対象
 */
async function stableResumeName(prefix: string, dataB64: string, ext: string): Promise<string> {
  const hash = (await sha256Hex(dataB64)).slice(0, 20)
  const safePrefix = (prefix || 'cand').replace(/[.\s　・]/g, '_').replace(/[^\w]/g, '').slice(0, 40)
  return `${safePrefix}_${hash}.${ext}`
}

/**
 * 重複メール判定（from + subject + 本文先頭200文字のハッシュ）
 * @param dedupSalt 添付分割時に各呼び出しを区別するためのサフィックス（省略時は空文字）
 * @returns true なら重複（処理済み）
 * 非重複の場合、ハッシュを app_config に記録して次回以降の判定に使う
 */
async function checkEmailDuplicate(
  supabase: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>,
  from: string,
  subject: string,
  body: string,
  dedupSalt = '',
): Promise<{ isDuplicate: boolean; configKey: string }> {
  try {
    const hash = await sha256Hex(`${from}|${subject}|${body.slice(0, 200)}|${dedupSalt}`)
    const configKey = `ehash_${hash.slice(0, 24)}`
    const { data } = await supabase.from('app_config').select('value').eq('key', configKey).maybeSingle()
    if (data?.value) {
      const storedAt = new Date(data.value).getTime()
      if (Date.now() - storedAt < 12 * 60 * 60 * 1000) {
        return { isDuplicate: true, configKey }
      }
    }
    return { isDuplicate: false, configKey }
  } catch (e) {
    console.warn('[DEDUP] 重複判定失敗、続行:', String(e))
    return { isDuplicate: false, configKey: '' }
  }
}

/** 処理成功時にDEDUPハッシュを確定記録する */
async function markEmailProcessed(
  supabase: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>,
  configKey: string,
): Promise<void> {
  if (!configKey) return
  try {
    await supabase.from('app_config').upsert(
      { key: configKey, value: new Date().toISOString() },
      { onConflict: 'key' },
    )
  } catch (e) {
    console.warn('[DEDUP] ハッシュ記録失敗:', String(e))
  }
}

/** 処理失敗時にDEDUPハッシュを削除して次回再試行できるようにする */
async function unmarkEmailProcessed(
  supabase: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>,
  configKey: string,
): Promise<void> {
  if (!configKey) return
  try {
    await supabase.from('app_config').delete().eq('key', configKey)
    console.log('[DEDUP] 処理失敗のためハッシュを削除、次回再試行:', configKey)
  } catch (e) {
    console.warn('[DEDUP] ハッシュ削除失敗:', String(e))
  }
}

/**
 * 複数人材メールで、ブロック（人材）と添付ファイルを名前・駅名で「全体最適」に割り当てる。
 *
 * 送信側が「1メール複数人材 + 各人のExcelを1ファイルずつ添付」する形式に対応:
 *   - ファイル名 "Y.N_神立.xlsx" → 名前 "Y.N" もしくは駅名 "神立" を手がかりに紐付け
 *
 * 2 パス方式で誤割当を防ぐ:
 *   - パス1 名前マッチ（厳密）: ファイル名にイニシャル/フルネームが含まれるブロックへ確実に割り当て
 *   - パス2 駅名マッチ（弱い手がかり）: パス1で残ったブロックのみ対象。
 *           ただし「ファイル名に自分以外のブロック名が含まれる」場合は他人の経歴書とみなしスキップ
 *
 * 例: N.U（浦和駅）と D.U（浦和駅）が同一メール、添付が "D.U_浦和駅.xlsx" のとき
 *   - パス1: D.U が名前マッチ → D.U に割当
 *   - パス2: N.U が駅(浦和)で当たるが、ファイル名に他人 "D.U" が含まれるため奪わずスキップ
 *
 * 一方、ファイル名が駅名のみ（例: "浦和.xlsx"）で他人名を含まなければ、駅マッチで正常に割り当てる。
 *
 * @returns Map<blockIdx, attachment>
 */
function assignAttachmentsToBlocks<T extends { label: string; content?: string }>(
  blocks: Array<{ name: string | null; station: string | null }>,
  attachments: T[],
): Map<number, T> {
  const result = new Map<number, { label: string; content?: string; skillYears?: Record<string, number> }>()
  if (attachments.length === 0 || blocks.length === 0) return result

  const normFiles = attachments.map(att => {
    const filenameMatch = att.label.match(/\(([^)]+)\)/)
    const raw = filenameMatch ? filenameMatch[1] : att.label
    return raw.toLowerCase().replace(/[.\s　]/g, '')
  })
  // 全ブロックの正規化名（パス2で「他人の名前を含むファイル」を除外するため）
  const allNormNames = blocks
    .map(b => (b.name ? b.name.replace(/[.\s　]/g, '').toLowerCase() : ''))
    .filter(n => n.length >= 2)
  const used = new Set<number>()

  // ── パス1: 名前マッチ（ファイル名にブロック名が含まれる） ──
  blocks.forEach((b, blockIdx) => {
    if (!b.name) return
    const normName = b.name.replace(/[.\s　]/g, '').toLowerCase()
    if (normName.length < 2) return
    for (let i = 0; i < attachments.length; i++) {
      if (used.has(i)) continue
      if (normFiles[i].includes(normName)) {
        result.set(blockIdx, attachments[i])
        used.add(i)
        break
      }
    }
  })

  // ── パス2: 駅名マッチ（パス1で未割当のブロックのみ・他人名を含むファイルは除外） ──
  blocks.forEach((b, blockIdx) => {
    if (result.has(blockIdx)) return
    const station = b.station
    if (!station || station.length < 2) return
    const myNorm = b.name ? b.name.replace(/[.\s　]/g, '').toLowerCase() : ''
    const stationLower = station.toLowerCase()
    for (let i = 0; i < attachments.length; i++) {
      if (used.has(i)) continue
      if (!normFiles[i].includes(stationLower)) continue
      // ファイル名に自分以外のブロック名が含まれる → 他人の経歴書なので奪わない
      const belongsToOther = allNormNames.some(n => n !== myNorm && normFiles[i].includes(n))
      if (belongsToOther) {
        continue
      }
      result.set(blockIdx, attachments[i])
      used.add(i)
      break
    }
  })

  // ── パス2.5: ファイル内容にイニシャルが含まれる（ファイル名がランダムな場合の対策） ──
  // ファイル名で判別できなかった場合、Excel/Wordのテキスト内容からイニシャルを探す。
  // 他のブロックのイニシャルも含む場合は曖昧なため除外する。
  blocks.forEach((b, blockIdx) => {
    if (result.has(blockIdx)) return
    if (!b.name) return
    const myNormName = b.name.replace(/[.\s　]/g, '').toLowerCase()
    if (myNormName.length < 2) return
    for (let i = 0; i < attachments.length; i++) {
      if (used.has(i)) continue
      // 空白（\s）は除去しない: 添付内の別セル・別行の値を跨いで連結されると、短いイニシャル
      // （2文字）が偶然一致してしまう事故になるため（例: "JBOSS"+"FrameWork" → "…ossf…"）。
      const content = (attachments[i].content ?? '').toLowerCase().replace(/[.]/g, '')
      if (!content.includes(myNormName)) continue
      // 他のブロックのイニシャルも含まれる → 曖昧なので除外
      const ambiguous = allNormNames.some(n => n !== myNormName && n.length >= 2 && content.includes(n))
      if (ambiguous) continue
      result.set(blockIdx, attachments[i])
      used.add(i)
      break
    }
  })

  // ── パス3: 1対1残余マッチング（未割当ブロック数 == 未使用添付数 == 1 の場合） ──
  // ファイル名に誰の名前も駅名もない「職務経歴書.xlsx」等の汎用名でも
  // 残り1件同士なら安全に割り当てられる（順序依存リスクを最小化）
  const unmatchedBlockIdxs = blocks
    .map((_, i) => i)
    .filter(i => !result.has(i) && blocks[i].name)
  const unusedAttachIdxs = attachments
    .map((_, i) => i)
    .filter(i => !used.has(i))
  if (unmatchedBlockIdxs.length === 1 && unusedAttachIdxs.length === 1) {
    const blockIdx = unmatchedBlockIdxs[0]
    const attIdx = unusedAttachIdxs[0]
    result.set(blockIdx, attachments[attIdx])
    used.add(attIdx)
  }

  return result
}

/**
 * 1メールに複数人材が区切り線（`*****`/`-----` 8文字以上）で並んでいる場合に分割する。
 *
 * メール構造（Phoenixテクノロジーズ等）:
 *   [前置き]
 *   N0774 MT (61才 男性)   ← 各ブロックの直前行が氏名
 *   ********...
 *   【時　期】即日
 *   【単　価】65万
 *   ...
 *   ********...
 *   N0773 OM ...
 *
 * 戻り値: ブロックが2件以上あれば string[] を返す。1件以下なら null。
 */
// 構造化フィールドを含む判定（【氏名】/ ◇◆ ラベル / 名前：ラベルなし形式）
// ■氏名：形式（■●▪▶ 等のビュレット付き）も認識
// 「■MM（石川町）男性・57歳」のように括弧内が駅名で■が付かず「最寄駅：」「希望単金：」等の
// フィールド行が続く形式もあるため、ビュレット文字は必須にせず・「単金」表記も許容する
// ※ splitMultiCandidateBody と detectRoster（名簿判定）で共用するためモジュールスコープに置く
const MULTI_CANDIDATE_FIELD_RE = /【[^】]{1,10}】|[◇◆][^\n：:]{1,15}[：:]|(?:^|\n)[ 　]*[■●▪▶]?[ 　]*(?:名前|氏[ 　]*名)[　 ]*[：:]|[■●▪▶]?[ 　]*(?:最寄(?:り?駅?)|希望単価|希望単金|スキル|業務経験|稼働開始|稼働時期|アピール)/
// 【 氏 名 】（半角スペース区切り形式）・■氏名：形式・■SI（28歳／男性）形式にも対応
// 「■MM（石川町）男性・57歳」（括弧内は駅名、性別・年齢は括弧の外に「・」区切りで続く）にも対応
const MULTI_NAME_FIELD_RE = /【[^】]{0,5}(?:氏名|お名前|名前|姓名|氏　名|氏　　名|名　前|名　　前)[^】]{0,5}】|【氏[^】]{0,3}】|【[ 　]*氏[ 　]*名[ 　]*】|【[ 　]*名[ 　]*前[ 　]*】|^[■●▪▶]?[ 　]*氏[ 　]*名[　 ]*[：:]|^名前[　 ]*[：:]|[◇◆]名前[　 ]*[：:]|^[■●▪▶◆◇][A-Za-zＡ-Ｚａ-ｚ.\-]{1,8}（\d+歳|^[■●▪▶◆◇][A-Za-zＡ-Ｚａ-ｚ]{1,10}[（(][^)）\d]{1,15}[）)][　 ]*(?:男性|女性|男|女)[・･]/m

function splitMultiCandidateBody(body: string): string[] | null {
  const CANDIDATE_FIELD_RE = MULTI_CANDIDATE_FIELD_RE
  const NAME_FIELD_RE = MULTI_NAME_FIELD_RE
  const lines = body.split(/\r?\n/)

  function trySplit(delimRe: RegExp): string[] | null {
    const delimIndices: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (delimRe.test(lines[i])) delimIndices.push(i)
    }
    if (delimIndices.length < 2) return null
    const delimSet = new Set(delimIndices)
    const allParts: string[] = []
    let current: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (delimSet.has(i)) { allParts.push(current.join('\n')); current = [] }
      else current.push(lines[i])
    }
    if (current.length > 0) allParts.push(current.join('\n'))
    // フッター・法的免責文・「以上になります」ブロックを候補者として処理しない
    const FOOTER_BLOCK_RE = /^(?:以上になります|以上です|よろしくお願いいたします|本メールに記載された|【重要[：:])/
    const blocks: string[] = []
    // allParts[0]（先頭区切り線より前）は通常「挨拶文等の前置きのみ」だが、先頭の候補者の
    // 直前に区切り線を置かず挨拶文にそのまま続けて書くテンプレートでは、allParts[0] 自体に
    // 1人目の候補者情報が紛れ込む（区切り線が2人目以降にしか無いため）。NAME_FIELD_RE の
    // マッチ位置以降を切り出せば、その候補者ブロックだけを回収できる。
    const preamble = allParts[0] ?? ''
    const preambleNameMatch = preamble.match(NAME_FIELD_RE)
    if (preambleNameMatch && preambleNameMatch.index !== undefined) {
      const leadingBlock = preamble.slice(preambleNameMatch.index).trim()
      if (leadingBlock.length >= 50 && CANDIDATE_FIELD_RE.test(leadingBlock)) {
        blocks.push(leadingBlock)
      }
    }
    for (let i = 1; i < allParts.length; i++) {
      const content = allParts[i].trim()
      if (!content || content.length < 50) continue
      if (FOOTER_BLOCK_RE.test(content.slice(0, 100))) continue
      if (!CANDIDATE_FIELD_RE.test(content)) continue
      const prevPart = allParts[i - 1] ?? ''
      const prevLines = prevPart.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean)
      const nameLine = prevLines[prevLines.length - 1] ?? ''
      const block = (nameLine && prevPart.trim().length < 80 && !CANDIDATE_FIELD_RE.test(prevPart.trim()))
        ? `${nameLine}\n${content}` : content
      blocks.push(block)
    }
    const blocksWithName = blocks.filter(b => NAME_FIELD_RE.test(b))
    return blocksWithName.length >= 2 ? blocks : null
  }

  // Pass 1: = と ー のみ（- を除外して laize 形式の内部 ---- による誤分割を防ぐ）
  // Pass 2: - を含む全パターン（ical 等の --- のみの形式に対応）
  // Pass 1: - を除外（laize 内部の ---- による誤分割防止）。━ U+2501 / ─ U+2500 / ― U+2015 / — U+2014 / ー U+30FC を含む
  //         全角ビュレット ●○■□◆◇ の連続も区切り線として扱う（ai-more 等が候補者間の区切りに使用。
  //         これが無いと「●●●●…」区切りの複数人名簿が1人目だけの単一候補者に潰れる実害があった）
  // Pass 2: - も含む（ical 等の --- のみ形式に対応）
  return trySplit(/^[\*=＊＝━ーー─―—●○■□◆◇]{8,}\s*$/)
      ?? trySplit(/^[\*\-=＊＝━ーー─―—●○■□◆◇]{8,}\s*$/)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  let traceRid = ''
  /** 最後に「ここまで進んだ」状態（FATAL 時に記録） */
  let tracePhase = 'none'
  /** DEDUPハッシュのapp_configキー（処理成功時に確定記録、失敗時に削除するためcatch外で保持） */
  let dedupConfigKey = ''

  try {
    traceRid = crypto.randomUUID().slice(0, 8)
    // ゾーンT: エントリ台帳（全ゾーンのステージコード・不変条件違反を記録）
    const ledger = createLedger(traceRid)
    tracePhase = 'parse_raw'
    // form-urlencoded と JSON 両対応
    const contentType = req.headers.get('content-type') ?? ''
    let raw: Record<string, string> = {}

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await req.text()
      const params = new URLSearchParams(text)
      for (const [k, v] of params.entries()) raw[k] = v
    } else if (contentType.includes('multipart/form-data')) {
      const fd = await req.formData()
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') {
          raw[k] = v
        } else if (v instanceof Blob) {
          const ab = await v.arrayBuffer()
          const b64 = uint8ToBase64(new Uint8Array(ab))
          const mime = v.type || 'application/octet-stream'
          const fileName = v instanceof File ? v.name : k
          if (!raw['attachment[data]']) {
            raw['attachment[data]'] = b64
            raw['attachment[mimeType]'] = mime
            raw['attachment[name]'] = fileName || k
          }
        }
      }
    } else {
      const j = (await req.json()) as Record<string, unknown>
      for (const [k, v] of Object.entries(j)) {
        raw[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      }
    }

    mergeUrlSearchParamsIntoRaw(req, raw)

    const rawKeys = Object.keys(raw).sort()
    const pickedMode = pickInboundMode(raw, req)
    let queryHasMode = false
    try {
      const u = new URL(req.url)
      queryHasMode = u.searchParams.has('mode') || u.searchParams.has('data_env')
    } catch { /* ignore */ }
    const inboundDataEnv = resolveInboundDataEnv(pickedMode)
    tracePhase = 'resolved_env_type'

    const type: string = normalizeInboundType(raw.type)
    /** 手動登録など、app_config フラグをバイパスして強制処理する場合は true */
    const forceProcess: boolean = raw.force === 'true'
    /** 再解析時に指定された既存候補者 ID。このブロックに対応するブロックを強制 UPDATE するために使う */
    const targetCandidateId: string | null = raw.target_candidate_id ?? null
    const from: string = parseFrom(raw.from ?? '')
    const subject: string = raw.subject ?? ''

    // ── MAILER-DAEMON: 配信失敗通知は無条件スキップ ──────────────────────
    if (/^mailer-daemon/i.test(from) || /^mailer-daemon/i.test(subject)) {
      console.warn('[SKIP_MAILER_DAEMON]', { rid: traceRid, from, subject })
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'MAILER_DAEMON' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ── 自社ドメインスキップ: force=true（手動登録・再解析）またはデモ環境はバイパス ──────
    if (!forceProcess && inboundDataEnv === 'prod') {
      const supabaseUrl2 = Deno.env.get('SUPABASE_URL') ?? ''
      const serviceKey2 = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      const ownDomain = await loadOwnEmailDomain(supabaseUrl2, serviceKey2)
      if (ownDomain) {
        const fromDomain = from.split('@')[1]?.toLowerCase() ?? ''
        if (fromDomain === ownDomain.toLowerCase()) {
          console.warn('[SKIP_OWN_DOMAIN]', { rid: traceRid, from, ownDomain })
          return new Response(
            JSON.stringify({ ok: true, skipped: true, reason: 'OWN_DOMAIN' }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          )
        }
      }
    }
    // Outlookがメールを実際に受信した日時（poll-emailから渡される）
    const emailReceivedAt: string | null = typeof raw.email_received_at === 'string' ? raw.email_received_at : null
    const pickedPlain = pickEmailPlainBody(raw)
    let rawBody: string = pickedPlain
    rawBody = unwrapMicrosoftGraphBody(rawBody)
    if (!rawBody.trim() && pickedPlain.trim()) {
      console.warn('[body] unwrap で空のため pickedPlain にフォールバック', { picked_len: pickedPlain.length })
      rawBody = pickedPlain.trim()
    }
    // HTMLタグが含まれている場合は除去してプレーンテキスト化
    // <br> のみのメールや <ul><li> 形式も検出対象に含める
    let body: string = rawBody.includes('<html') || rawBody.includes('<div') || rawBody.includes('<p ')
      || rawBody.includes('<p>') || rawBody.includes('<table') || rawBody.includes('<span') || rawBody.includes('<td')
      || rawBody.includes('<br') || rawBody.includes('<ul') || rawBody.includes('<ol') || rawBody.includes('<li')
      || rawBody.includes('<h1') || rawBody.includes('<h2') || rawBody.includes('<h3')
      ? stripHtml(rawBody)
      : rawBody
    // stripHtml が過剰に空になるケース（構造だけの HTML 等）は解析不能になるため raw にフォールバック
    // ただし rawBody 自体もタグ除去後に空なら HTML 構造のみ（空ボディ等）→ フォールバックしない
    if (!body.trim() && rawBody.trim()) {
      const rawStripped = rawBody.replace(/<[^>]+>/g, '').trim()
      if (rawStripped) {
        console.warn('[body] stripHtml で空のため rawBody にフォールバック', {
          picked_plain_len: pickedPlain.length,
          rawBody_len: rawBody.length,
        })
        body = rawBody.trim()
      }
      // else: rawBodyもタグ除去で空 → 空メールボディのまま（HTML タグ由来の skill_master 誤マッチ防止）
    }

    // 転送・返信メールの引用ヘッダを除去（「取得 Outlook for Mac 差出人:...」等が先頭に追加される）
    // 引用区切り行以降を除去して本文だけを残す
    // 【強区切り】転送/返信ヘッダは位置に関係なく除去
    const STRONG_QUOTE_DELIMITERS = [
      // 日本語転送パターン: 「---------- 転送メッセージ ----------」
      /^[-─━=＝*]{5,}[ 　]*(?:転送|Forwarded|Original)/mi,
      // 差出人ブロック: 「--- 差出人: ---」や Outlook 形式
      /^[-_]{3,}[\s\S]*?差出人[:：]/m,
    ]
    for (const delim of STRONG_QUOTE_DELIMITERS) {
      const m = body.search(delim)
      if (m > 0) { body = body.slice(0, m).trim(); break }
    }
    // 【弱区切り】位置 > 200 のときのみ除去（本文内の区切り線との誤混同を防止）
    const WEAK_QUOTE_DELIMITERS = [
      /^_{3,}\s*$/m,
      /^From:\s+/m,
      /^送信元：/m,
    ]
    for (const delim of WEAK_QUOTE_DELIMITERS) {
      const m = body.search(delim)
      if (m > 200) { body = body.slice(0, m).trim(); break }
    }

    // 添付ファイルの解決（attachment[data] 形式 → Attachment オブジェクト）
    let attachments: Attachment[] = []
    if (raw['attachment[data]']) {
      attachments = [{
        data: raw['attachment[data]'],
        mimeType: raw['attachment[mimeType]'] ?? '',
        name: raw['attachment[name]'] ?? undefined,
      }]
    } else if (raw.attachmentsJson) {
      try {
        const parsed = JSON.parse(raw.attachmentsJson) as unknown
        if (Array.isArray(parsed)) attachments = attachmentsFromParsedArray(parsed)
      } catch { /* ignore */ }
    } else if (Array.isArray(raw.attachments)) {
      attachments = attachmentsFromParsedArray(raw.attachments)
    } else if (typeof raw.attachments === 'string' && raw.attachments.trim()) {
      attachments = attachmentsFromJsonArrayString(raw.attachments)
    }

    const t0 = Date.now()
    const elapsed = () => `${Date.now() - t0}ms`

    tracePhase = 'step1_body_normalized'
    const supportedAttachments = attachments.filter(a => SUPPORTED_MIME.includes(a.mimeType))

    // Word/Excelのテキスト抽出（MIMEタイプ + 拡張子の両方で判定）
    const officeTextContents: { label: string; content: string; skillYears?: Record<string, number>; attachment?: Attachment; jsonRows?: Array<Record<string, string>>; skillSummary?: string; grid?: string[][]; links?: { cell: string; url: string }[]; totalProjectMonths?: number }[] = []
    let excelSkillYears: Record<string, number> = {}
    let wordSkillYearsForDisplay: Record<string, number> = {}  // 表示用のみ・経験年数推定には使わない
    let excelSkillSummary: string | undefined  // Excel スキルシートの「スキルサマリ」セル
    // HF Spaces 品質チェック用: 添付から抽出した生グリッド（Excel優先、なければWord）
    let attachmentParsedGrid: { source: 'excel'; rows: Array<Record<string, string>> } | { source: 'word'; rows: string[][] } | null = null
    // 「添付はあるのにスキル年数が入っていない」を後から切り分けられるようにするための診断メモ。
    // パース自体が例外で失敗したのか、パースは成功したがスキル年数が0件だったのかを区別して記録する。
    // 品質スコア選択（scoreSkillQuality）用に skill_master キャッシュをプリフェッチ。
    // 添付解析より前に _skillNameSet を温めておく（5分TTLキャッシュ・コールドスタート時のみDB1回）。
    // 失敗しても続行＝スコアが件数比較に退化するだけで抽出自体は動く
    try {
      const preClient = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))
      getSkillNameSet(await getSkillMasterFromDb(preClient))
    } catch (e) {
      console.warn('[skill_master] プリフェッチ失敗（品質スコアは件数退化で続行）:', String(e))
    }

    const excelParseNotes: string[] = []
    // Word/Excel/PDFのいずれの判定にも一致せず完全に無視された添付を記録する診断情報。
    // 従来はこのケースがログにすら残らず、「メールに実際は複数添付があったのに1件しか
    // 処理されなかった」という事故（曖昧な複数人材への誤共有の疑いと誤認しやすい）を
    // 事後的に切り分けられなかったため追加した。
    const unrecognizedAttachments: string[] = []
    for (const att of attachments) {
      const attNameLower = (att.name ?? '').toLowerCase()
      const isWordByMime = WORD_MIME.includes(att.mimeType)
      const isExcelByMime = EXCEL_MIME.includes(att.mimeType)
      const isWordByExt = /\.(doc[xm]?)$/.test(attNameLower) && !isExcelByMime
      const isExcelByExt = /\.(xls[xmb]?|ods|csv)$/.test(attNameLower) && !isWordByMime
      if (isWordByMime || isWordByExt) {
        const { text: rawText, totalProjectMonths: wordMonths, skillYears: wordSkillYears, grid: wordGrid, links: wordAttLinks } = await extractWordText(att.data)
        if (rawText.trim()) {
          const text = cleanseWordText(rawText)
          officeTextContents.push({ label: `Word文書(${att.name ?? 'document'})`, content: text, attachment: att, grid: wordGrid, links: wordAttLinks, totalProjectMonths: wordMonths })
        } else console.warn(`[Word] 抽出結果が空: ${att.name} mimeType=${att.mimeType}`)
        // Word スキル別経験年数は表示用のみ（経験年数推定には使わない）
        if (wordSkillYears && Object.keys(wordSkillYearsForDisplay).length === 0) {
          wordSkillYearsForDisplay = { ...wordSkillYears }
        }
        // Word のプロジェクト期間合計のみ経験年数フォールバックに使用（Excel優先）
        if (wordMonths && Object.keys(excelSkillYears).length === 0) {
          excelSkillYears['_totalProjectMonths'] = wordMonths
        }
        // HF Spaces 用グリッド（Excel が未取得の場合のみ保存）
        if (!attachmentParsedGrid && wordGrid && wordGrid.length > 0) {
          attachmentParsedGrid = { source: 'word', rows: wordGrid }
        }
      } else if (isExcelByMime || isExcelByExt) {
        // 1 回のパースで text と skillYears を同時取得（二重パース防止）
        const { text, skillYears: years, jsonRows: excelJsonRows, skillSummary: excelSS, parseError, grid: excelGrid, links: excelLinks } = await extractExcelAll(att.data)
        if (excelSS && !excelSkillSummary) excelSkillSummary = excelSS
        const attLabel = att.name ?? 'spreadsheet'
        if (text.trim()) officeTextContents.push({
          label: `Excelファイル(${attLabel})`,
          content: text,
          skillYears: Object.keys(years).length > 0 ? years : undefined,
          attachment: att,
          jsonRows: excelJsonRows && excelJsonRows.length > 0 ? excelJsonRows : undefined,
          skillSummary: excelSS,
          grid: excelGrid,
          links: excelLinks,
        })
        else console.warn(`[Excel] 抽出結果が空: ${att.name} mimeType=${att.mimeType}`)
        // _totalProjectMonths / _dateSpanMonths は経験年数推定専用の内部キーで、
        // スキル別年数としては表示されない。「表示用のスキル年数が実質0件」を正しく
        // 判定するため、内部キーを除いた実スキル名の有無で判定する。
        const realSkillYearKeys = Object.keys(years).filter(k => k !== '_totalProjectMonths' && k !== '_dateSpanMonths')
        if (parseError) {
          excelParseNotes.push(`${attLabel}: パース失敗 (${parseError})`)
        } else if (!text.trim()) {
          excelParseNotes.push(`${attLabel}: 抽出結果が空`)
        } else if (realSkillYearKeys.length === 0) {
          excelParseNotes.push(`${attLabel}: パース成功だがスキル年数0件`)
        }
        // 単体候補者パス用: 最初の非空 Excel の skillYears を excelSkillYears に保存
        if (Object.keys(excelSkillYears).length === 0 && Object.keys(years).length > 0) {
          excelSkillYears = years
        }
        // HF Spaces 用 JSON 行（Excel を優先・上書き）
        if (excelJsonRows && excelJsonRows.length > 0) {
          attachmentParsedGrid = { source: 'excel', rows: excelJsonRows }
        }
      } else if (att.mimeType === 'application/pdf' || /\.pdf$/i.test(attNameLower)) {
        // PDF テキスト抽出。attachment を設定しないと複数人材パスの Storage
        // アップロード判定（matchedTextContent.attachment）で弾かれ、PDF経歴書だけ
        // resume_url が設定されない実害があったため、Excel/Word同様に att を保持する
        const pdfText = await extractPdfText(att.data)
        if (pdfText.trim()) {
          officeTextContents.push({ label: `PDF(${att.name ?? 'document.pdf'})`, content: pdfText.slice(0, 8000), attachment: att })
        } else {
          // raw_profile.excelParseNotes に永続化する（console.log だけでは Edge ログ失効後に
          // 「skillYears が空」の原因が PDF 読み取り失敗だと特定できない — monitor_quality [B] の調査用）
          excelParseNotes.push(`PDF(${att.name ?? 'document.pdf'}): テキスト層なし（スキャンPDF等・抽出0文字）`)
          console.log(`[PDF] テキスト層なし（スキャンPDF）: ${att.name ?? 'document.pdf'}`)
        }
      } else if (!SUPPORTED_MIME.includes(att.mimeType)) {
        // Word/Excel/PDFのいずれとも判定されなかった添付（画像等を除く未対応形式）。
        // 従来はここで何もせず黙って無視していたため、メールに実際は複数添付が
        // あったのに一部だけ処理された、という事故を後から検知できなかった。
        const note = `${att.name ?? '(名前なし)'} mimeType=${att.mimeType || '(空)'}`
        unrecognizedAttachments.push(note)
        console.log(`[attachment] 未対応形式のため無視: ${note}`)
      }
    }
    tracePhase = 'step3_office_done'

    // ② 本文が極端に短い（50文字未満）かつ添付なし → 自動返信・通知メール等として即スキップ
    const plainBodyLength = body.trim().length
    if (plainBodyLength > 0 && plainBodyLength < 50 && attachments.length === 0) {
      tracePhase = 'skip_too_short'
      console.warn('[SHORT_BODY] 本文が短すぎるためスキップ', { rid: traceRid, bodyLen: plainBodyLength, subject })
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'BODY_TOO_SHORT', bodyLen: plainBodyLength }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ② 研修報告・案件紹介メールをスキップ（人材メールボックスの誤登録対策）
    // 複数人材メール（区切り線2本以上）は前置きテキストに案件紹介フレーズを含む場合があるため
    // splitMultiCandidateBody で先に構造を確認し、2人以上いればスキップをバイパスする
    const earlyMultiCheck = type === 'candidate' ? splitMultiCandidateBody(body) : null
    if (type === 'candidate' && !forceProcess && !earlyMultiCheck) {
      const TRAINING_KEYWORDS = [
        '研修内容について報告します',
        '【本日の作業進捗】',
        '【研修名】',
        '【週明けの作業予定】',
        '【明日の作業予定】',
      ]
      const PROJECT_SOLICITATION_KEYWORDS = [
        '対応可能な人材がいらっしゃいましたら',
        '案件情報のご紹介でございます',
        '案件情報のご紹介となります',
        '案件のご紹介でございます',
        '案件のご紹介をいたします',
        '案件のご紹介です',
        '要員様のご提案をお願いいたします',
        '厚意顧客の注力案件のご紹介',
        'チョータツ',
        '弊社案件のご紹介',
        'ご紹介の案件',
        'ご提案いただける方',
        'ご提案いただければ',
        '要員をお探し',
        '該当する方がいらっしゃいましたら',
        'ご参画いただける方がいれば',
        'ご検討いただける人材がいれば',
        'ご参画いただける人材',
        '見合う要員様',
        // 案件メールが人材BOXに誤着するパターン（2026-05-29追加）
        'マッチされる方がいらっしゃいましたら',
        'ご支援頂けます技術者様が居られましたら',
        '弊社プロジェクトでの募集情報をお送りいたします',
        '成約時には派遣契約かつ貴社から支援費',
        // 案件募集が人材BOXに届くパターン（2026-05-30追加）
        '下記案件にて要員を募集',
        '下記の案件で要員を募集',
        '案件にて技術者を募集',
        // 注力案件の紹介メールが人材boxに届くパターン
        '注力している案件',
        // 案件リスト・マッチング依頼メール（#68）
        '注力案件リスト',
        'スキルマッチする案件がございましたら',
        '弊社営業.*名の注力',
        // 案件紹介メールが人材BOXに届くパターン（#91）
        '対応可能な要員様がいらっしゃいましたら',
        '下記案件を紹介させていただきたく',
        'ご対応いただける要員がいらっしゃいましたら',
        '案件紹介させていただきたく',
        // 案件探しメール（要員を探している側が送るメール）
        '下記案件にて要員を探しております',
        '見合う方がおりましたらご提案',
        '弊社に於きまして下記の案件がございます',
        '下記の案件がございます。ご対応可能な方',
        '弊社の案件にご対応いただける',
        // 案件紹介一斉配信メール（三鋭システム等が使うパターン・2026-07-05追加）
        '表記の件について、ご紹介いたします',
      ]
      // 営業・広告・メルマガメールのスキップ（研修販売・サービス紹介等）
      const COMMERCIAL_SOLICITATION_KEYWORDS = [
        'メール配信解除',
        '配信停止はこちら',
        '配信解除はこちら',
        'メルマガ登録',
        '受信拒否はこちら',
        'このメールは配信専用',
        '本メールは配信専用アドレス',
        'こちらのメールは送信専用',
        '新人向けインフラ研修',
        '新人エンジニア育成',
        '助成金の活用も可能',
        '定員に達し次第受付を締め切',
        // 自動返信・不在通知
        '不在のため', '自動返信', 'Auto Reply', 'Out of Office', 'Automatic reply',
        // 求人・採用サービス広告
        '求人サービスのご案内', '採用支援サービス', '人材採用にお困りでは',
        '採用コスト削減', '求人掲載のご案内', '転職サービスのご案内',
        // 会計・法務・補助金系DM
        '補助金・助成金', '税務申告のご案内', '法人向けサービスのご案内',
        // IT商材DM
        'DX推進のご支援', 'クラウド移行のご提案', 'セキュリティ診断のご案内',
        // 会社説明会・セミナー招待
        'セミナーのご案内', 'ウェビナーのご案内', '説明会のご案内',
        '無料セミナー', '無料ウェビナー',
        'オンライン開催（Zoom）',
        // 社内業務メール・システム通知（人材メールboxへの誤配信）
        '勤務明細書を提出', '客先向けの勤務表', 'SAP Fieldglass',
        // 案件メールが人材boxに誤配信されるパターン
        '支払いサイト', '【案件名】',
        // 採用動画・パスワード通知等のDM
        '採用動画', 'パスワードのご連絡',
        // 日程調整・アポイントメントメール（ご都合をお知らせください等）
        '日程調整のお願い', 'ご都合のよい日時', 'ご都合をお知らせ',
        '情報交換に伺わせていただ', '情報交換に伺わせてください',
        'ご挨拶に伺わせていただ', '弊社をご紹介させていただ',
        // システム障害・業務連絡メール
        'メールシステムに不具合が発生',
        'メール送受信に影響が生じております',
        // パスワード通知・添付ファイル分離通知
        '添付ファイルダウンロードセンター',
        '添付ファイル分離のお知らせ',
        // フィッシング・詐欺メール
        'メールアカウントは閉鎖予定',
        // 研修・スクール案内メール
        'オフィスの会議室が検証ラボに',
        // 広告・サービス提案メール
        '協業のご相談', '提携のご相談', '運用型広告',
        // 採用サービス・SNS採用営業（LinkedIn等）2026-07-05追加
        'LinkedIn活用', 'Linkedinを活用した', 'スカウト改善',
      ]
      // 件名ベースのスキップキーワード（業務連絡・勤務表・発注書・打合せ等）
      const SUBJECT_SKIP_KEYWORDS = [
        '勤務表', '勤怠表', '作業報告書', '作業報告', '月報', '週報',
        'お打合せ', 'ミーティング', '打ち合わせ',
        '注文書', '発注書', '請求書', '納品書', '契約書送付',
        '新体制', '組織変更', '移転のご案内',
        '定例会', '定例MTG',
        // 業務連絡・通知系（人材メールboxへの誤配信・2026-05-29追加）
        '作業依頼書', 'コラボレーション依頼',
        'failure notice',  // MAILER-DAEMON配信失敗通知
        // 給与・経費・許可証等の業務連絡
        '控除について', '稼働時間について', '請求関連', '許可証',
        // 派遣更新・NDA交渉等の業務往来メール（2026-06-03追加）
        '派遣更新連絡', '情報交換のご相談',
        // 名刺交換・ご挨拶・日程調整等の一般ビジネス往来メール
        '名刺交換', 'ご挨拶にお伺い', 'はじめてご連絡',
        // 退職・異動挨拶メール（2026-07-05追加）
        '退職のご挨拶', '退職挨拶',
      ]
      // 件名が「【スキル名】~XX万｜条件がある方｜XX歳まで」形式の案件条件メールをスキップ
      // rightarm.co.jp 等が人材BOXに案件要件メールを誤送信するパターン（2026-06-03追加）
      const isJobRequirementSubject = /【.{1,20}】[〜~]?\d+万.*(がある方|できる方|歳まで|以上の経験|歳以下)/.test(subject)
      const isTraining = TRAINING_KEYWORDS.some(kw => body.includes(kw))
      const isSolicitation = PROJECT_SOLICITATION_KEYWORDS.some(kw => body.includes(kw))
      const isCommercial = COMMERCIAL_SOLICITATION_KEYWORDS.some(kw => body.includes(kw)) ||
        body.includes('NDAにつきましては') || body.includes('CloudSignでの締結')
      const isSubjectSkip = SUBJECT_SKIP_KEYWORDS.some(kw => subject.includes(kw)) || isJobRequirementSubject
      if (isTraining || isSolicitation || isCommercial || isSubjectSkip) {
        const skipReason = isTraining ? 'TRAINING_REPORT' : isSolicitation ? 'PROJECT_SOLICITATION' : isSubjectSkip ? 'SUBJECT_KEYWORD' : 'COMMERCIAL_SOLICITATION'
        console.warn(`[SKIP_IRRELEVANT] ${skipReason}`, { rid: traceRid, subject })
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: skipReason }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    if (!body.trim() && attachments.length === 0) {
      tracePhase = 'skip_empty_body_attachments'
      // Make.com は HTTP エラーでシナリオが止まるため、明らかな空メールは 200 でスキップし後続フローを継続させる
      console.warn('[EMPTY_BODY_AND_ATTACHMENTS] 取り込みスキップ（200）', {
        rid: traceRid,
        picked_plain_len: pickedPlain.length,
        rawBody_len: rawBody.length,
        body_final_len: body.length,
        note: 'STEP0 フィールド長の picked_plain_len は stripHtml 前。STEP1 bodyLength は展開・HTML除去後。',
        type,
        inboundDataEnv,
        receivedKeys: rawKeys,
      })
      return new Response(
        JSON.stringify({
          ok: true,
          skipped: true,
          reason: 'EMPTY_BODY_AND_ATTACHMENTS',
          message: '本文・添付ともに無いため取り込みをスキップしました（Make の後続処理は続行できます）',
          receivedKeys: rawKeys,
          bodyLengthAfterPick: body.trim().length,
          type,
          inboundDataEnv,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      )
    }

    tracePhase = 'supabase_connect'
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

    tracePhase = 'pre_supabase'

    // ③ 重複メール判定（同一メールが複数受信箱に転送された場合の二重処理防止）
    // dedup_salt: poll-email が添付分割する際に添付ファイル名を渡す（分割呼び出し間の衝突を防ぐ）
    const dedupSalt = raw.dedup_salt ?? ''
    tracePhase = 'dedup_check'
    const { isDuplicate, configKey: _dedupConfigKey } = await checkEmailDuplicate(supabase, from, subject, body, dedupSalt)
    dedupConfigKey = _dedupConfigKey
    if (isDuplicate && !forceProcess) {
      console.warn('[DEDUP] 重複メールのためスキップ', { rid: traceRid, subject, from: from.slice(0, 80) })
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'DUPLICATE_EMAIL' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }
    // 重複なし → ハッシュをまだ記録しない（処理成功後に記録する）

    // ④ 送信者の1日上限チェック（一斉配信業者によるAIコスト急騰対策）
    // 1送信者から1日50件超はスキップ（Bedrock費用急増を防ぐ）
    const SENDER_DAILY_LIMIT = 50
    if (from && type === 'candidate' && !forceProcess) {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const { count: senderCount } = await supabase
        .from('candidates')
        .select('id', { count: 'exact', head: true })
        .eq('data_env', inboundDataEnv)
        .gte('created_at', todayStart.toISOString())
        .filter('raw_profile->>from', 'eq', from)
      if ((senderCount ?? 0) >= SENDER_DAILY_LIMIT) {
        console.warn(`[RATE_LIMIT] 送信者上限超過スキップ from=${from} count=${senderCount}`)
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: 'SENDER_DAILY_LIMIT' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    tracePhase = 'drive_links_fetch'
    // ゾーンA+B: Google Drive / Sheets / Docs リンクを統一エントリとして取得・抽出（設計書v4）
    // 旧fetchGoogleLinksのdriveSheetSkillYears無条件上書きは廃止 — skillYearsは
    // 候補者に割り当てられたエントリからのみ採用する（ゾーンE pickSkillYears）
    const googleEntries = await collectGoogleEntries(body, ledger)
    const rawAllAttachments = [...supportedAttachments]
    tracePhase = 'drive_links_done'

    // PDFはテキスト抽出済み（officeTextContents に追加済み）。allAttachments からは除外（Storage upload は別途実施）
    const allAttachments = rawAllAttachments.filter(a => a.mimeType !== 'application/pdf')

    // Box URL の検出（人材登録時にスプレッドシートへ書き込み・DB保存するため事前に抽出）
    const boxUrls = type === 'candidate' || type === 'human' ? extractBoxUrls(body) : []
    if (boxUrls.length > 0) {
      console.log('[Box] Box URL検出:', boxUrls)
    }

    // ゾーンE設計: resume_url の優先順位を反転（本人割当ファイルのStorage URL > 本文リンク）。
    // 単一人材パスでは後段の resolveResumeUrl がゲート通過エントリから決定する。
    // ここでは複数人材パスのケースC（名前不明ブロック）用フォールバックとして本文リンクのみ保持する。
    // 旧実装の「本文リンクがあれば添付のStorageアップロード自体をスキップ」（F.Kさん実害）は廃止。
    let resumeUrl: string | null = null
    let bodyResumeLink: string | null = null
    if (type === 'candidate' || type === 'human') {
      bodyResumeLink = pickBodyResumeLink(body)
      resumeUrl = bodyResumeLink
    }

    // ゾーンA: メール添付も統一エントリへ正規化（normalizeAttachment 相当）。
    // これで4系統すべてが SourceEntry になり、以降はソース別の分岐を持たない。
    const officeEntries: SourceEntry[] = officeTextContents.map((t) => {
      const entryId = ledger.nextEntryId()
      const kind: SourceEntry['kind'] = t.label.startsWith('Word') ? 'word' : t.label.startsWith('PDF') ? 'pdf' : 'excel'
      ledger.log(entryId, 'B-EXTRACT-OK', `attachment ${t.label} t=${t.content.length}`)
      return {
        entryId,
        label: t.label,
        content: t.content,
        filename: t.attachment?.name ?? t.label,
        kind,
        origin: 'attachment' as const,
        skillYears: t.skillYears,
        attachment: t.attachment,
        jsonRows: t.jsonRows,
        skillSummary: t.skillSummary,
        grid: t.grid,
        links: t.links,
        totalProjectMonths: t.totalProjectMonths,
      }
    })

    // ゾーンC: 名簿判定・行展開（全エントリ・候補者割当より前）。
    // 名簿は行ごとに独立エントリへ展開され、「1エントリ=1人」が下流に保証される。
    // 本文に書かれている人材の氏名を優先対象として渡す: 名簿が15行上限で打ち切られても、
    // 本文で紹介された人の行（+リンク先経歴書）は必ず展開対象に入るようにする
    tracePhase = 'roster_expand'
    const bodyPriorityNames = (earlyMultiCheck ?? [body])
      .map((t) => extractCandidateFieldsRegex(t, '').name ?? extractNameFallback(t))
      .filter((n): n is string => !!n)
    const allTextContents: SourceEntry[] = await expandRosterEntries([...googleEntries, ...officeEntries], ledger, undefined, bodyPriorityNames)

    // ── skill_master DB照合（AIなし・全タイプ共通） ────────────────────────
    // 本文と添付を分けて照合し、精度を向上させる。
    //
    // 【本文】subject + body
    //   - 構造が保たれているため厳密な照合（certContext 空なら資格スキップ）
    //
    // 【添付】Drive テキスト / Office / PDF 抽出テキスト
    //   - フォーマットが崩れる場合があるため資格は looseCert=true（certContext 空でも全文fallback）
    //   - 本文で既にマッチしたスキルは重複登録しない
    const masterSkills = await getSkillMasterFromDb(supabase)

    const bodyText = decodeHtmlEntities([subject, body].join('\n'))
    const { matched: bodyMatched } = extractAndRemoveSkills(bodyText, masterSkills, { looseCert: false })

    const attachText = allTextContents.map(t => t.content ?? '').join('\n')
    const bodyMatchedNames = new Set(bodyMatched.map(s => s.name))
    const attachRawMatched = attachText.trim()
      ? extractAndRemoveSkills(attachText, masterSkills, { looseCert: true }).matched
      : []
    // スキルシート形式（A〜E 評価テーブル）を検出し D/E 評価スキルを除外
    const attachRated = filterBySkillRating(attachText, attachRawMatched)
    // 添付は上位40件に絞る（スキルシート一覧等の過剰ヒットを防ぐ。Wordの職務経歴書は40件超もありうる）
    const attachDeduped = attachRated.filter(s => !bodyMatchedNames.has(s.name)).slice(0, 40)
    const attachDedupCount = attachRated.filter(s => bodyMatchedNames.has(s.name)).length

    const dbMatchedSkills = [...bodyMatched, ...attachDeduped]
    // 求人票のセクション見出し・汎用語など、スキルとして不適切な単語を除外する
    const SKILL_NOISE_WORDS = new Set([
      '必須', '歓迎', '尚可', '優遇', '経験', '実務', '業務', '対応', '作業',
      '設計', '開発', '実装', '保守', '運用', '管理', '構築', '調査', '分析',
      '改善', '構成', '制作', '作成', '提案', '支援', '担当', '従事', '参画',
    ])
    const dbSkillNames = dbMatchedSkills.map(s => s.name).filter(n => !SKILL_NOISE_WORDS.has(n))

    // カテゴリ別内訳（品質確認用）
    const byCategory = dbMatchedSkills.reduce((acc, s) => {
      acc[s.category] = (acc[s.category] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
    const certNames = dbMatchedSkills.filter(s => s.category === 'certifications').map(s => s.name)
    const attachRatingFiltered = attachRawMatched.length - attachRated.length
    console.log(
      `[skill_master] DB照合: body=${bodyMatched.length}件 attach生=${attachRawMatched.length}件(D/E除外${attachRatingFiltered}件→評価後${attachRated.length}件→重複除外${attachDedupCount}件→${attachDeduped.length}件) 合計=${dbMatchedSkills.length}件`,
    )
    // ── 人材メール ────────────────────────────────────────────
    if (type === 'candidate' || type === 'human') {
      // body が空の場合はsubjectを本文代わりに使う（cy-tech等の件名のみメール対策）
      // HTMLエンティティをデコードして保存（&#26684; → 格 等）
      // PostgreSQL JSONB は null byte (\u0000) と lone surrogate を許容しないため除去
      const sanitizeForPgJson = (s: string) =>
        s.replace(/\u0000/g, '').replace(/[\uD800-\uDFFF]/g, '')
      const effectiveBody = sanitizeForPgJson(decodeHtmlEntities(body.trim() ? body : subject))
      // reprocess_no_skill_years.mjs の Strategy B が body 末尾に埋め込む疑似添付テキストを
      // DB保存用本文からは除去する（パース処理には effectiveBody をそのまま使う）
      const EMBED_ATTACH_SEP = '\n\n--- 添付テキスト ---\n'
      const storedBodyText = effectiveBody.includes(EMBED_ATTACH_SEP)
        ? effectiveBody.slice(0, effectiveBody.indexOf(EMBED_ATTACH_SEP))
        : effectiveBody

      // ── 複数人材検出（*****や-----の区切り線） ─────────────────────────────
      // earlyMultiCheck は body で事前計算済み（effectiveBody と同一の場合は再利用）
      let multiBlocks = earlyMultiCheck ?? splitMultiCandidateBody(effectiveBody)

      // ゾーンD: 名簿にしか載っていない人材を新規候補者ブロックとして起こす（設計書v4）。
      // 名簿行エントリの氏名が本文ブロックの誰とも一致しない場合、行テキストを候補者ブロックに
      // 昇格させ、本文由来の候補者と同じ検証・dedup処理を通す。
      const rosterRowEntries = allTextContents.filter(e => e.rosterRowName)
      if (rosterRowEntries.length > 0) {
        const baseBlocks = multiBlocks && multiBlocks.length >= 2 ? multiBlocks : [effectiveBody]
        const baseNames = baseBlocks.map(b => {
          const t = decodeHtmlEntities([subject, b].join('\n'))
          return extractCandidateFieldsRegex(t, '').name ?? extractNameFallback(t)
        })
        const promoted = promoteUnassignedRosterEntries(rosterRowEntries, baseNames, ledger)
        if (promoted.length > 0) {
          if (multiBlocks && multiBlocks.length >= 2) {
            multiBlocks = [...multiBlocks, ...promoted.map(p => p.rowText)]
          } else {
            // 単一人材メール + 名簿: 本文に氏名があれば本文ブロックも残し、名簿行と並べて複数人材として処理
            const bodyHasName = baseNames[0] != null
            const synthesized = [...(bodyHasName ? [effectiveBody] : []), ...promoted.map(p => p.rowText)]
            if (synthesized.length >= 2) multiBlocks = synthesized
          }
        }
      }
      if (multiBlocks && multiBlocks.length >= 2) {
        console.log(`[multi-candidate] ${multiBlocks.length}人検出 from=${from} subject=${subject.slice(0, 80)}`)
        tracePhase = 'multi_candidate'

        // グループメールの署名から送信元会社名を先に抽出（各ブロックのフォールバック用）
        // ブロック分割後は各候補者の断片テキストのみになり署名が含まれないため
        const multiBodyCompanyName: string | null = (() => {
          const sig = body.slice(-2000)
          const PRE_RE = /(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[　 ]?([^\s　の\n（(、。！【】「」]{2,30})/g
          const afterSalutation = (t: string, i: number, l: number) => /^[\r\n　 ]*(?:様|御中|ご担当|担当者様)/.test(t.slice(i + l, i + l + 40))
          // 署名エリアなので最初の非宛先マッチを使う（後続のカッコ内旧社名説明を拾わないように）
          let m: RegExpExecArray | null
          while ((m = PRE_RE.exec(sig)) !== null) {
            if (afterSalutation(sig, m.index, m[0].length)) continue
            const name = sanitizeFromCompany(`${m[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]}${m[1]}`)
            // "から"/"変更" を含む場合は旧社名説明なのでスキップ
            if (name && !/から|変更|になります/.test(name)) return name
          }
          return null
        })()
        if (multiBodyCompanyName) console.log(`[multi-candidate] 送信元会社名: ${multiBodyCompanyName}`)

        const attachmentNames = [
          ...allAttachments.map(a => a.name ?? ''),
          ...officeTextContents.map(t => t.label),
        ].filter(Boolean).join('\n')

        type BlockResult = { id: string; name: string; skills: number }
        const results: BlockResult[] = []
        const allBlockBoxUrls: string[] = []
        // 同一メール内のループ内重複防止: このバッチで既に登録/更新した name → id のマップ
        const batchNameToId = new Map<string, string>()

        // ── Pre-pass: 全ブロックの名前・駅名を一括抽出 → 添付ファイルとの「全体最適」割当を先に確定 ──
        // 旧版は各ブロックの for-loop 内で個別に findMatchingTextContent を呼んでおり、
        // 同じ駅に住む別人材の Excel が「駅名一致」だけで誤って割り当たる事故が発生していた。
        const blockMetas = multiBlocks.map((block) => {
          const text = decodeHtmlEntities([subject, block].join('\n'))
          const fields = extractCandidateFieldsRegex(text, '')
          return {
            name: fields.name ?? extractNameFallback(text) ?? null,
            station: fields.nearestStation ?? null,
          }
        })
        const blockAttachAssignment = assignAttachmentsToBlocks(blockMetas, allTextContents)

        // ゾーンD: 名簿昇格ブロックは由来の行エントリと1:1が確定しているため、曖昧マッチに
        // 頼らず内容一致で確定割当する。名簿行のラベルは全行とも親ファイル名になり（パス1不発）、
        // リンク先本文の英語技術語に他人のイニシャルが偶然含まれてパス2.5も全滅する実害があった
        // （実例: 実名簿E2Eで14ブロック全て未割当 → resume_url全滅）
        {
          const assignedVals = new Set(blockAttachAssignment.values())
          for (let bi = 0; bi < multiBlocks.length; bi++) {
            if (blockAttachAssignment.has(bi)) continue
            const rowEntry = allTextContents.find(t =>
              t.rosterRowName && t.content === multiBlocks[bi] && !assignedVals.has(t))
            if (rowEntry) {
              blockAttachAssignment.set(bi, rowEntry)
              assignedVals.add(rowEntry)
            }
          }
        }

        // ゾーンT: 不変条件チェック（サイレント失敗の検出器）
        {
          const assignedVals = [...blockAttachAssignment.values()]
          if (new Set(assignedVals).size !== assignedVals.length) ledger.violate('INV-D-DUP', '同一エントリが複数ブロックに割当')
          for (const [bIdx, ent] of blockAttachAssignment.entries()) {
            ledger.log((ent as SourceEntry).entryId, 'D-ASSIGNED', `block=${bIdx} ${blockMetas[bIdx]?.name ?? ''}`)
          }
          for (const e of allTextContents) {
            if (!assignedVals.includes(e) && e.attachment?.data && !e.rosterRowName) {
              ledger.log(e.entryId, 'D-UNASSIGNED')
            }
          }
        }

        // ケースB共有URL: 名前はあるが添付が割当てられなかったブロックが「ちょうど1人」の場合のみ、
        // 残り1件の未割当添付を安全に割り当てる（実質1対1の残余マッチング）。
        // 2人以上が未確定の場合、どちらか1人の本物の経歴書を無関係な他人にも見せてしまう事故になるため
        // 共有はせず resume_url は設定しない（誤った経歴書を見せるより無しの方が安全）。
        const assignedEntriesPre = new Set(blockAttachAssignment.values())
        const unmatchedNameBlockCount = blockMetas.filter((m, i) => m.name && !blockAttachAssignment.has(i)).length
        const singleSafeUnassignedEntry = unmatchedNameBlockCount === 1
          ? allTextContents.find(t => !assignedEntriesPre.has(t) && t.attachment?.data)
          : undefined

        // undefined = まだ計算していない / null = アップロード失敗または対象外 / string = URL
        let caseBSharedResumeUrl: string | null | undefined = undefined

        // 同一添付テキストのスキル照合結果をメモ化（ケースC等で全ブロックが同じ attachText を
        // 照合し、重い extractAndRemoveSkills をブロック数ぶん重複実行して546になるのを防ぐ）
        const attachSkillCache = new Map<string, { name: string; category: string }[]>()
        // multi ループ全体の時間予算。超過後のブロックは重い添付スキル照合を省き本文スキルのみで
        // 登録する（候補者は全員作る＝取りこぼしゼロ、後ろのブロックのスキルが本文由来のみになる劣化）。
        const multiLoopDeadline = Date.now() + 4000

        for (const [blockIdx, block] of multiBlocks.entries()) {
          try {
            // ── Step1: 本文のみから名前・駅名を先行抽出（フィールド抽出側で利用） ──
            const blockNameForMatch = blockMetas[blockIdx].name
            const blockStationForMatch = blockMetas[blockIdx].station

            // ── Step2: 事前計算した添付割当を参照（複数人材限定・2 パス済み） ────────
            // ケースA: 名前または駅名で割り当てられた添付がある → その人の経歴書
            // ケースB: 名前はあるが添付が割当てられない → 未確定なのが自分1人だけの場合に限り
            //   残り1件の未割当添付を渡す（singleSafeUnassignedEntry、resume_url割当と同じ判定基準）。
            //   2人以上が未確定の場合、他人の実データ（スキル年数等）が混入する事故になるため空文字にする。
            // ケースC: 本ブロックの名前が取れていない → フォールバックで全添付共有（従来動作）
            const matchedTextContent = blockAttachAssignment.get(blockIdx) ?? null
            let blockAttachText: string
            let blockAttachLabel: string
            if (matchedTextContent) {
              // ケースA
              blockAttachText = matchedTextContent.content ?? ''
              blockAttachLabel = matchedTextContent.label
            } else if (blockNameForMatch && allTextContents.length > 0) {
              // ケースB: 未確定ブロックが自分1人だけの場合のみ、残り1件の未割当添付を使う
              blockAttachText = singleSafeUnassignedEntry?.content ?? ''
              blockAttachLabel = singleSafeUnassignedEntry?.label ?? ''
            } else {
              // ケースC
              blockAttachText = attachText
              blockAttachLabel = attachmentNames
            }

            // ── Step3: ブロック固有のスキル照合 ──────────────────────────────────
            // 件名・プリアンブルはいずれも全員共通のため per-block スキル照合から除外する
            // （プリアンブルに最初の候補者の ※C言語(8年1ヶ月) 等が含まれると他全員に誤付与される）
            const blockBodyText = block
            const { matched: blockBodyMatched } = extractAndRemoveSkills(blockBodyText, masterSkills, { looseCert: false })
            const blockBodyMatchedNames = new Set(blockBodyMatched.map(s => s.name))
            // 添付スキル照合: メモ化で同一テキストの再計算を避け、時間予算超過後は省いて本文スキルのみにする
            let blockAttachRaw: { name: string; category: string }[] = []
            if (blockAttachText.trim()) {
              const cached = attachSkillCache.get(blockAttachText)
              if (cached) blockAttachRaw = cached
              else if (Date.now() <= multiLoopDeadline) {
                blockAttachRaw = extractAndRemoveSkills(blockAttachText, masterSkills, { looseCert: true }).matched
                attachSkillCache.set(blockAttachText, blockAttachRaw)
              }
            }
            const blockAttachRatedLocal = filterBySkillRating(blockAttachText, blockAttachRaw)
            const blockAttachDeduped = blockAttachRatedLocal.filter(s => !blockBodyMatchedNames.has(s.name)).slice(0, 10)
            const blockDbMatchedSkills = [...blockBodyMatched, ...blockAttachDeduped]
            const blockSkillNames = blockDbMatchedSkills.map(s => s.name)

            // ── Step4: フィールド抽出（件名＋ブロック本文＋マッチ添付テキスト） ──
            const blockRegexBodyText = decodeHtmlEntities([subject, block, blockAttachLabel].join('\n'))
            const blockRegexFields = extractCandidateFieldsRegex(blockRegexBodyText, blockAttachText)
            // 最寄駅 DB 照合で都道府県を確定（テキスト誤抽出も上書き）(#90)
            if (blockRegexFields.nearestStation) {
              const stationPref = await lookupStationPrefectureFromDb(blockRegexFields.nearestStation)
              if (stationPref && stationPref !== blockRegexFields.prefecture) {
                blockRegexFields.prefecture = stationPref
              }
            }
            const blockProseFields = extractFromProse(blockRegexBodyText, blockAttachText)

            // 名前解決の優先順位:
            // 1. blockMetas 事前パス（添付テキストなし・ブロック本文のみ）: 兄弟ブロックの添付が混入しない
            // 2. blockRegexFields（添付テキストあり）: 添付に氏名ラベルがある場合に有効
            // 3. extractNameFallback（イニシャル検索）
            // 4. extractCandidateCode（件名コード）
            // ※ blockMetas を優先する理由: ケースBで兄弟ブロックの Excel が blockAttachText に混入すると
            //   Phase2a が他人の名前を抽出して上書きする誤りが発生するため（例: M.M ブロックが Y.M と登録される）
            const blockResolvedNameRaw = blockMetas[blockIdx].name
              ?? blockRegexFields.name
              ?? extractNameFallback([blockRegexBodyText, blockAttachText].join('\n'))
              ?? extractCandidateCode(subject)
              ?? '不明'
            // 氏名の全角英数字は半角へ正規化（「ＳＡ」と「SA」を同一人物として dedup させる。
            // 同一名簿内で同じ人が全角/半角で2ブロックに分かれ重複登録される実害があった: ai-more）
            const blockResolvedName = blockResolvedNameRaw.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
              String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
            // 名前が取れないブロックは署名・フッター等とみなしてスキップ
            if (blockResolvedName === '不明' && blockRegexFields.name == null) {
              continue
            }
            const blockRemoteAvailable = blockProseFields.workStyle === 'フルリモート'
              || blockProseFields.workStyle === 'リモート可'
              || blockProseFields.workStyle === 'リモート希望'
            const blockBoxUrls = extractBoxUrls(block)
            if (blockBoxUrls.length > 0) allBlockBoxUrls.push(...blockBoxUrls)

            // ── per-block Storage アップロード（候補者名・駅名でファイル名付け） ──
            // matchedTextContent が確定した後に実行することで「誰のExcelか」が確定してからアップロードできる
            // ケースA（マッチあり）: 候補者名_駅名.xlsx で保存 → resume_url に設定
            // ケースB（マッチなし・名前あり）: 未割当Excelを共有URLとしてアップロード（初回のみ）
            // ケースC（名前不明）: 従来通り resumeUrl（Googleドライブ等）を流用
            let blockResumeUrl: string | null = null
            if (matchedTextContent) {
              const origAtt = matchedTextContent.attachment
              if (origAtt?.data) {
                const ext = (origAtt.name ?? 'xlsx').split('.').pop() ?? 'xlsx'
                const safeStation = (blockStationForMatch ?? '').replace(/[^\w\u3040-\u9FFF]/g, '').slice(0, 15)
                const safeCandName = blockResolvedName.replace(/[.\s　]/g, '_')
                // ファイル名の一意部分に内容ハッシュを使う（stableResumeName のコメント参照）。
                // 別内容（同姓同名の別人）は違うハッシュで別パスになり上書き事故を防ぎ、
                // かつ同一内容の再処理では同じパスになり重複ファイルを作らない。
                const uploadName = await stableResumeName(`${safeCandName}_${safeStation}`, origAtt.data, ext)
                blockResumeUrl = await uploadToStorage(uploadName, origAtt.mimeType, origAtt.data)
                if (blockResumeUrl) console.log(`[multi] Storage upload: ${uploadName} → ${blockResumeUrl}`)
              }
            } else if (blockNameForMatch) {
              // ケースB: 未確定ブロックが自分1人だけの場合のみ、残り1件の未割当添付を安全に割当。
              // 2人以上が未確定の場合は singleSafeUnassignedEntry が undefined になるため、
              // 誤って他人の経歴書を共有せず resume_url なしのままにする。
              //
              // 追加の安全確認: 送信側が無関係なファイルを誤って多く添付したケース等では
              // 「未割当ブロック1件・未割当添付1件」が偶然一致してしまい、全く他人の経歴書を
              // 誤って共有する事故になりうる（実例: 添付内容にブロック名が一切含まれない）。
              // 残った添付の内容に自分の名前（イニシャル）が含まれない場合は共有せず
              // resume_url なしのままにする（誤った経歴書を見せるより無しの方が安全）。
              if (caseBSharedResumeUrl === undefined) {
                const origAtt = singleSafeUnassignedEntry?.attachment
                // 空白文字（\s）は除去しない: Excelの別セル・別行の値を跨いで連結してしまうと
                // 偶然2文字が一致するだけで安全チェックを素通りする（例: "JBOSS"+"FrameWork" → "…ossf…"
                // に「S・F」の正規化名 "sf" が偶然含まれてしまう）。名前内部の区切り文字（. ・）のみ除去する。
                const entryContent = (singleSafeUnassignedEntry?.content ?? '').toLowerCase().replace(/[.・]/g, '')
                const myNormNameForSafety = blockResolvedName.replace(/[.\s　・]/g, '').toLowerCase()
                const contentMentionsOther = myNormNameForSafety.length >= 2 && !entryContent.includes(myNormNameForSafety)
                if (origAtt?.data && !contentMentionsOther) {
                  const ext = (origAtt.name ?? 'xlsx').split('.').pop() ?? 'xlsx'
                  // 内容ハッシュベースの安定名（再処理での重複複製を防ぐ・stableResumeName のコメント参照）
                  const sharedName = await stableResumeName('shared', origAtt.data, ext)
                  caseBSharedResumeUrl = await uploadToStorage(sharedName, origAtt.mimeType, origAtt.data) ?? null
                  if (caseBSharedResumeUrl) console.log(`[multi] Case B single-safe upload: ${sharedName} → ${caseBSharedResumeUrl}`)
                } else {
                  if (origAtt?.data && contentMentionsOther) {
                    console.log(`[multi] Case B skip: 残り添付の内容に「${blockResolvedName}」が含まれないため共有せず`)
                  }
                  caseBSharedResumeUrl = null
                }
              }
              blockResumeUrl = caseBSharedResumeUrl
            } else {
              // ケースC: 名前不明 → Google Drive URL 等の resumeUrl をフォールバック使用
              blockResumeUrl = resumeUrl
            }

            const blockPayload = {
              data_env: inboundDataEnv,
              name: blockResolvedName,
              email: null as string | null,
              phone: null as string | null,
              skills: blockSkillNames,
              experience_years: (() => {
                let expYears = blockRegexFields.experienceYears
                // Excel skillYears から経験年数を推定
                // 優先順位: max-min日付スパン → _totalProjectMonths合計 → スキル最大月数
                if (matchedTextContent?.skillYears) {
                  const sy = matchedTextContent.skillYears
                  const dateSpanMonths = sy['_dateSpanMonths'] ?? null
                  const totalMonths = sy['_totalProjectMonths'] ?? null
                  const maxSkillMonths = Object.entries(sy)
                    .filter(([k]) => k !== '_totalProjectMonths' && k !== '_dateSpanMonths')
                    .map(([, v]) => v)
                    .reduce((a, b) => Math.max(a, b), 0)
                  const estimatedMonths = dateSpanMonths ?? totalMonths ?? (maxSkillMonths > 0 ? maxSkillMonths : null)
                  if (estimatedMonths && estimatedMonths > 0) {
                    const excelYears = estimatedMonths / 12
                    // Excel の方が大きければ Excel を採用（実プロジェクト期間ベースで正確）。
                    // ただし本文に「経験年数：」等の専用ラベルからの明示的な自己申告値がある場合は、
                    // 候補者本人の意図的な申告を優先し、Excel日付スパン（前職期間等を含み
                    // 過大評価しやすい）で上書きしない
                    if (expYears == null || (!blockRegexFields.experienceYearsIsDedicated && excelYears > expYears)) {
                      expYears = excelYears
                    }
                  }
                }
                // サニティチェック: 年齢が判明している場合、経験年数が「年齢-15」を超える異常値
                // （結合セル崩れ等で日付範囲を誤解析したケース）を検知し、年齢フォールバックに任せる。
                // 1年未満（セル分断で断片的な数値を誤って拾い、Math.round後に0年になるケースを含む）も
                // 同様に信頼できないため対象に含める（例: 0.3年 → 厳密な===0では素通りしてしまう）
                if (expYears != null && (expYears < 1 || (blockRegexFields.age != null && expYears > blockRegexFields.age - 15))) {
                  expYears = null
                }
                // 年齢フォールバック: 経験年数が取れない場合、年齢から22を引いて推定（新卒22歳基準）
                if (expYears == null) {
                  const blockAge = blockRegexFields.age
                  if (blockAge != null && blockAge >= 24 && blockAge <= 70) {
                    expYears = blockAge - 22
                  }
                }
                return toExperienceYears(expYears)
              })(),
              raw_profile: {
                text: storedBodyText,
                summary: '',
                skillsByCategory: blockDbMatchedSkills.reduce((acc, s) => {
                  if (!acc[s.category]) acc[s.category] = []
                  acc[s.category].push(s.name)
                  return acc
                }, {} as Record<string, string[]>),
                roles: blockProseFields.roles,
                industries: blockProseFields.industries,
                nearestStation: blockRegexFields.nearestStation,
                prefecture: blockRegexFields.prefecture,
                availableRegions: null,
                currentWorkLocation: null,
                remoteAvailable: blockRemoteAvailable,
                workStyleNote: extractWorkStyleNote(blockRegexBodyText, blockAttachText),
                workStyleTag: deriveWorkStyleTag(extractWorkStyleNote(blockRegexBodyText, blockAttachText)),
                from, subject,
                emailReceivedAt,
                attachmentCount: allAttachments.length,
                // 元メールに実際に含まれていた添付の総数（Excel/Word等のoffice文書も含む）。
                // attachmentCount は画像/PDF等のみをカウントしatxlsx/docxを含まないため、
                // 「このメールに添付が本当になかったか」を判定する際は必ずこちらを参照すること。
                sourceAttachmentCount: allAttachments.length + officeTextContents.length + unrecognizedAttachments.length,
                // Word/Excel/PDFのいずれとも判定されず無視された添付（未対応形式）の一覧。
                // 空なら undefined にして raw_profile を肥大化させない。
                unrecognizedAttachments: unrecognizedAttachments.length > 0 ? unrecognizedAttachments : undefined,
                // メール全体で正常にパース出来た添付の全ラベル一覧（候補者ごとの割当結果とは無関係）。
                // attachmentNames は「この候補者に割り当てられたものだけ」しか残らないため、
                // 「メールに実際何個添付があり、それぞれ何というファイル名だったか」を
                // 特定の1候補者レコードからでも確認できるようにするための共通診断情報。
                allParsedAttachmentLabels: officeTextContents.length > 0 ? officeTextContents.map(t => t.label) : undefined,
                // 添付はあるのにスキル年数が0件のケースで、パース失敗なのか本当に0件だったのかを
                // 切り分けるための診断メモ（問題がなければ undefined）
                excelParseNotes: excelParseNotes.length > 0 ? excelParseNotes : undefined,
                // ケースA: マッチした添付のラベルのみ / ケースB: [] / ケースC: 全添付（フォールバック）
                attachmentNames: matchedTextContent
                  ? [matchedTextContent.label]
                  : blockNameForMatch
                    ? []
                    : [...allAttachments.map(a => a.name ?? a.mimeType), ...officeTextContents.map(t => t.label)],
                driveLinks: googleEntries.map(t => t.label),
                // ゾーンT: この候補者に割り当てられたエントリの台帳＋メール全体サマリー
                pipeline_trace: ledger.serializeTrace(matchedTextContent ? [(matchedTextContent as SourceEntry).entryId] : []),
                availableFrom: blockRegexFields.availableFrom,
                desiredProject: blockRegexFields.desiredProject,
                age: blockRegexFields.age,
                gender: blockRegexFields.gender,
                nationality: blockRegexFields.nationality,
                employmentType: extractEmploymentType(blockRegexBodyText, blockAttachText).employmentType,
                commercialFlow: extractEmploymentType(blockRegexBodyText, blockAttachText).commercialFlow,
                selfPR: extractSelfPR(block, blockAttachText) ?? null,
                agentComment: extractAgentComment(block, blockAttachText) ?? null,
                // 添付テキスト（再解析時に skillYears を再抽出できるよう保存）
                attachmentText: blockAttachText ? blockAttachText.slice(0, 5000) : undefined,
                multiCandidateBlock: true,
                // 名前後ろ括弧のスキル年数（#79）: 「K.T（Java 5年 / Python 3年）」形式
                // Excel skillYears: マッチした添付 > 再解析時の global excelSkillYears（blockIdx=0） > nameSkillYears
                skillYears: (() => {
                  const excSY = matchedTextContent?.skillYears
                    ?? (blockIdx === 0 && targetCandidateId && Object.keys(excelSkillYears).length > 0 ? excelSkillYears : {})
                  const display = Object.fromEntries(Object.entries(excSY).filter(([k]) => !k.startsWith('_')))
                  const nameYears = blockRegexFields.nameSkillYears ?? {}
                  // 本文・添付の文章パターンから常に抽出してマージ（Excel/nameYearsが空のキーを補完）
                  // ※ blockAttachText はこのブロック（本人）専用に確実にマッチした添付（matchedTextContent）の
                  //   場合のみ含める。ケースB/C（未割当添付の共有プール・全添付フォールバック）では
                  //   他人の経歴書の文章から年数を誤って拾ってしまうため対象外にする
                  const bodyYears = extractSkillYearsFromBodyText(
                    blockRegexBodyText + (matchedTextContent ? '\n' + blockAttachText : '')
                  )
                  // 優先順位: bodyYears < nameYears < Excel（後が上書き）
                  const merged = { ...bodyYears, ...nameYears, ...display }
                  return Object.keys(merged).length > 0 ? merged : undefined
                })(),
                // Excel スキルシートの「スキルサマリ」セル（selfPR・agentComment と並列の独自フィールド）
                // ※ ケースB/C（未確定添付）では他人のExcelデータが混入するため matchedTextContent 限定にする
                skillSummary: matchedTextContent?.skillSummary,
                // Excel スキルシートの JSON 化データ（HF Spaces 品質チェック用・同上の理由で matchedTextContent 限定）
                jsonRows: matchedTextContent?.jsonRows,
              },
              duplicate_flag: false,
              created_by: 'make-inbound',
              box_url: blockBoxUrls[0] ?? null,
              box_status: blockBoxUrls.length > 0 ? 'pending' : null,
              // ケースA: matchedTextContent あり → 候補者名でアップロード済みの blockResumeUrl
              // ケースB: 名前あり・マッチなし → null（誰のファイルか不明なのでセットしない）
              // ケースC: 名前不明 → resumeUrl フォールバック（= blockResumeUrl に設定済み）
              resume_url: blockResumeUrl,
              desired_rate: blockRegexFields.desiredRate ?? null,
              // ブロック内に署名がない場合はメール全体の署名から抽出した会社名をフォールバック使用
              from_company: sanitizeFromCompany(blockRegexFields.fromCompany) ?? multiBodyCompanyName,
            }

            // INSERT前に重複チェック（同一人物なら UPDATE してスキップ）
            let blockExistingId: string | null = null
            // ★ 再解析時: 最初のブロック（blockIdx===0）に target_candidate_id を強制適用
            if (targetCandidateId && blockIdx === 0) {
              blockExistingId = targetCandidateId
              console.log(`[reanalyze] block[0] target_candidate_id 強制 UPDATE: ${targetCandidateId}`)
            }
            // ① 同一メール内の既処理ブロックと名前が一致 → そのIDに UPDATE（DB未コミット分も補足）
            if (!blockExistingId && blockResolvedName && blockResolvedName !== '不明' && batchNameToId.has(blockResolvedName)) {
              blockExistingId = batchNameToId.get(blockResolvedName)!
            }
            // ② 同エージェント（同一 from）から同名が既に登録済み → UPDATE 判定
            // 　 件名一致 → 同一メール確定。件名違い → 駅・都道府県・年齢・経験年数の2つ以上一致で同一人物
            if (!blockExistingId && blockResolvedName && blockResolvedName !== '不明') {
              const { data: sameAgent } = await supabase
                .from('candidates').select('id, raw_profile, experience_years')
                .eq('data_env', inboundDataEnv)
                .eq('name', blockResolvedName)
                .eq('duplicate_flag', false)
                .is('merged_into', null)
                .eq('raw_profile->>from', from)
                .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
                .limit(5)
              if (sameAgent && sameAgent.length > 0) {
                for (const s of sameAgent) {
                  const theirRp = s.raw_profile as any
                  const sameSubject = theirRp?.subject === subject
                  let attrMatches = 0
                  const myStation = blockRegexFields.nearestStation ?? null
                  const theirStation = theirRp?.nearestStation ?? null
                  if (myStation && theirStation && myStation === theirStation) attrMatches++
                  const myPref = blockRegexFields.prefecture ?? null
                  const theirPref = theirRp?.prefecture ?? null
                  if (myPref && theirPref && myPref === theirPref) attrMatches++
                  const myAge = blockRegexFields.age ?? null
                  const theirAge = theirRp?.age ?? null
                  if (myAge != null && theirAge != null && myAge === theirAge) attrMatches++
                  const myExp = toExperienceYears(blockRegexFields.experienceYears)
                  const theirExp = (s as any).experience_years ?? null
                  if (myExp != null && theirExp != null && Math.abs(myExp - theirExp) < 2) attrMatches++
                  if (sameSubject || attrMatches >= 2) {
                    blockExistingId = s.id
                    break
                  }
                }
              }
            }
            // ③ DBに同名が存在するか確認（Jaccard類似度による同一人物判定）
            if (!blockExistingId && blockResolvedName && blockResolvedName !== '不明') {
              const { data: similar } = await supabase
                .from('candidates').select('id, name, skills, raw_profile, experience_years')
                .eq('data_env', inboundDataEnv)
                .eq('name', blockResolvedName)
                .eq('duplicate_flag', false)
                .is('merged_into', null)
                .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
                .limit(5)
              if (similar && similar.length > 0) {
                for (const s of similar) {
                  const myStation = blockRegexFields.nearestStation ?? null
                  const theirStation = (s.raw_profile as any)?.nearestStation ?? null
                  if (myStation && theirStation && myStation !== theirStation) continue
                  // 都道府県が両方存在して異なる場合は別人と判断
                  const myBlockPref = blockRegexFields.prefecture ?? null
                  const theirBlockPref = (s.raw_profile as any)?.prefecture ?? null
                  if (myBlockPref && theirBlockPref && myBlockPref !== theirBlockPref) continue
                  // 経験年数の差が5年以上の場合は別人と判断
                  const myBlockExp = toExperienceYears(blockRegexFields.experienceYears)
                  const theirBlockExp = (s as any).experience_years ?? null
                  if (myBlockExp != null && theirBlockExp != null && Math.abs(myBlockExp - theirBlockExp) >= 5) continue
                  const mySet = new Set(blockSkillNames.map(sk => sk.toLowerCase()))
                  const theirSet = new Set(((s.skills as string[]) || []).map(sk => sk.toLowerCase()))
                  const intersection = [...mySet].filter(sk => theirSet.has(sk)).length
                  const union = new Set([...mySet, ...theirSet]).size
                  if (union > 0 && intersection / union >= 0.4) {
                    blockExistingId = s.id
                    break
                  }
                }
              }
            }

            let blockSavedId: string
            if (blockExistingId) {
              const blockUpdatePayload: Record<string, unknown> = {
                skills: blockSkillNames,
                raw_profile: blockPayload.raw_profile,
                experience_years: blockPayload.experience_years,
                desired_rate: blockRegexFields.desiredRate ?? null,
                created_at: new Date().toISOString(),
              }
              // resume_url の扱い:
              // - このブロックで添付がマッチした（blockResumeUrl!=null）→ 常に上書き
              // - マッチ無し（null）→ 既存を「保持」する（キーを payload に含めない）。
              //   名簿メールで各人の経歴書が別々の添付になっている場合、poll-email の「添付分割
              //   モード」が添付ごとに inbound を複数回呼ぶ。各呼び出しでは本文の全員ぶんの
              //   ブロックが作られるが添付は1つだけマッチするため、null で常時上書きすると
              //   兄弟呼び出しが先に設定した正しい resume_url を後続呼び出しが null で潰し、
              //   全員 resume_url なしになる実害があった（CyTech/ai・more 名簿メール）。
              //   ※ Issue #121（古い誤った resume_url が残る）は、名簿誤検出・添付マッチ精度の
              //     改善で誤マッチ自体が減っているため、全員分を失う害の方が大きいと判断し保持を優先。
              if (blockResumeUrl) blockUpdatePayload.resume_url = blockResumeUrl
              if (blockPayload.from_company) blockUpdatePayload.from_company = blockPayload.from_company
              const { error: blockUpdateError } = await supabase
                .from('candidates').update(blockUpdatePayload)
                .eq('id', blockExistingId).eq('data_env', inboundDataEnv)
              if (blockUpdateError) {
                console.error(`[multi-candidate] 更新エラー "${blockResolvedName}":`, blockUpdateError.message)
                continue
              }
              blockSavedId = blockExistingId
            } else {
              const { data: blockData, error: blockError } = await supabase
                .from('candidates').insert(blockPayload).select().single()
              if (blockError) {
                console.error(`[multi-candidate] 保存エラー "${blockResolvedName}":`, blockError.message)
                continue
              }
              blockSavedId = blockData.id
            }

            // バッチ内重複防止: 処理済み名前を記録
            if (blockResolvedName && blockResolvedName !== '不明') {
              batchNameToId.set(blockResolvedName, blockSavedId)
            }

            // candidate_skills INSERT
            const blockSkillsPayload = blockDbMatchedSkills
              .filter(s => s.name?.trim())
              .map(s => ({ candidate_id: blockSavedId, category: s.category, skill: s.name.trim() }))
            if (blockSkillsPayload.length > 0) {
              await supabase.from('candidate_skills').delete().eq('candidate_id', blockSavedId)
              await supabase.from('candidate_skills').insert(blockSkillsPayload)
            }

            // skill_master match_count インクリメント（fire and forget）
            if (blockSkillNames.length > 0) {
              const matchedIds = masterSkills.filter(s => blockSkillNames.includes(s.name)).map(s => s.id)
              if (matchedIds.length > 0) {
                supabase.rpc('increment_skill_match_counts', { skill_ids: matchedIds })
                  .then(() => {}).catch(() => {})
              }
            }

            await supabase.from('ai_logs').insert({
              type: 'candidate',
              model: 'no-ai',
              from_address: from,
              subject,
              ai_result: { multiCandidateBlock: true, _field_sources: { skills: `db:${blockSkillNames.length}` } },
              prompt_length: 0,
              status: 'success',
              duration_ms: 0,
              linked_id: blockSavedId,
              raw_body: block.slice(0, 3000),
            })

            results.push({ id: blockSavedId, name: blockResolvedName, skills: blockSkillNames.length })
            console.log(`[multi-candidate] 登録完了: ${blockResolvedName} skills=${blockSkillNames.length}`)
          } catch (blockErr) {
            console.error(`[multi-candidate] ブロック処理エラー:`, String(blockErr))
          }
        }

        if (allBlockBoxUrls.length > 0) await appendToBoxSpreadsheet(allBlockBoxUrls)

        // agent_companies に会社名・ドメイン・許可番号を upsert（fire and forget）
        {
          const emailDomain = from ? from.split('@')[1]?.toLowerCase().trim() : null
          // 送信元会社名を末尾2000字から抽出（候補者名でなくエージェント会社名）(#96)
          const sigAreaMulti = body.slice(-2000)
          const preReMulti = /(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[　 ]?([^\s　の\n（(、。！【】「」]{2,30})/g
          let bestPreMulti: RegExpExecArray | null = null; let mMulti: RegExpExecArray | null
          const afterMulti = (t: string, i: number, l: number) => /^[\r\n　 ]*(?:様|御中|ご担当|担当者様)/.test(t.slice(i + l, i + l + 40))
          while ((mMulti = preReMulti.exec(sigAreaMulti)) !== null) { if (!afterMulti(sigAreaMulti, mMulti.index, mMulti[0].length)) bestPreMulti = mMulti }
          const companyName = bestPreMulti ? sanitizeFromCompany(`${bestPreMulti[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]}${bestPreMulti[1]}`) : null
          const ownDomain = 'i-voice.co.jp'
          if (emailDomain && emailDomain !== ownDomain && !emailDomain.includes('gmail') && !emailDomain.includes('yahoo') && !emailDomain.includes('outlook') && !emailDomain.includes('demo.invalid')) {
            const { haken, shokai } = extractLicenseNumbers(body)
            const licenseStatus = haken && shokai ? 'both' : haken ? 'haken' : shokai ? 'shokai' : undefined
            const upsertPayload: Record<string, unknown> = { domain: emailDomain, source: 'email' }
            if (companyName) upsertPayload.company_name = companyName
            if (haken) { upsertPayload.haken_number = haken; upsertPayload.verified_at = new Date().toISOString(); upsertPayload.verified_by = 'email' }
            if (shokai) { upsertPayload.shokai_number = shokai; upsertPayload.verified_at = new Date().toISOString(); upsertPayload.verified_by = 'email' }
            if (licenseStatus) upsertPayload.license_status = licenseStatus
            supabase.from('agent_companies').upsert(upsertPayload, { onConflict: 'domain', ignoreDuplicates: false }).then(() => {}).catch(() => {})
          }
        }

        await markEmailProcessed(supabase, dedupConfigKey)
        return new Response(
          JSON.stringify({ ok: true, type: 'multi-candidate', count: results.length, results }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      // ── 単一人材（通常モード）────────────────────────────────────────────

      // ゾーンD/E: 氏名照合ゲート → skillYears / resume_url を本人割当エントリから決定（設計書v4）。
      // 旧実装は単一人材だと検証なしで全エントリ・本文リンクを無条件に本人へ紐づけていた。
      tracePhase = 'single_gate'
      const singleEarlyText = decodeHtmlEntities([subject, effectiveBody].join('\n'))
      const singleMeta = { name: extractCandidateFieldsRegex(singleEarlyText, '').name ?? extractNameFallback(singleEarlyText) }
      const { assigned: gateAssigned } = gateSingleCandidate(singleMeta, allTextContents, ledger)
      const gatePickedSkillYears = pickSkillYears(gateAssigned, ledger)
      if (Object.keys(gatePickedSkillYears).length > 0) {
        excelSkillYears = gatePickedSkillYears
      } else if (gateAssigned.length < allTextContents.length) {
        // ゲートで除外されたエントリ由来の skillYears を使わない（他人データ汚染の防止）
        excelSkillYears = {}
      }
      resumeUrl = await resolveResumeUrl(gateAssigned, attachments, bodyResumeLink, singleMeta.name, ledger)

      const durationMs = 0
      const parseFallback: 'none' | 'body_only_after_attachment_timeout' = 'none'
      type CandAi = {
        name: string
        roles: string[]
        industries: string[]
        experienceYears: number | null; summary: string
        nearestStation: string | null
        prefecture: string | null
        availableRegions: string[] | null
        currentWorkLocation: string | null
        remoteAvailable: boolean
        desiredRate: string | null
        fromCompany: string | null
        age?: number | null
        availableFrom?: string | null
      }
      const analyzed: CandAi = {
        name: '',
        roles: [],
        industries: [],
        experienceYears: null,
        summary: '',
        nearestStation: null,
        prefecture: null,
        availableRegions: null,
        currentWorkLocation: null,
        remoteAvailable: false,
        desiredRate: null,
        fromCompany: null,
      }
      // スキルはDB照合結果のみ使用（AIによるスキル抽出廃止）
      // ただし skillYears のキーに skill_master 登録済みのスキルがあれば追加
      const skillSet = new Set(dbSkillNames)
      const syKeys = Object.keys(excelSkillYears).filter(k => !k.startsWith('_'))
      for (const syKey of syKeys) {
        if (skillSet.has(syKey)) continue
        const syLower = syKey.toLowerCase().replace(/\s+/g, '')
        // skill_master の name or alias に一致するか確認
        const smEntry = masterSkills.find(sm => {
          if (sm.name.toLowerCase().replace(/\s+/g, '') === syLower) return true
          return sm.aliases.some(a => a.toLowerCase().replace(/\s+/g, '') === syLower)
        })
        if (smEntry && !skillSet.has(smEntry.name)) {
          skillSet.add(smEntry.name)
          // カテゴリ別にも追加
          dbMatchedSkills.push(smEntry)
        }
      }
      const skills = [...skillSet]

      // AI結果が空の項目をregex 2段階補完
      const allAttachmentNames = [
        ...allAttachments.map(a => a.name ?? ''),
        ...officeTextContents.map(t => t.label),
      ].filter(Boolean).join('\n')
      // Phase1対象: 件名+本文+ファイル名 / Phase2対象: 添付テキスト
      // HTMLエンティティ（&#31292; → 稼 等）をデコードしてから正規表現抽出に渡す
      const regexBodyText = decodeHtmlEntities([subject, body, allAttachmentNames].join('\n'))
      const regexFields = extractCandidateFieldsRegex(regexBodyText, attachText)

      // name: AI → regex(ラベル抽出) → extractNameFallback(イニシャル) → 件名コード
      const _rawName = (analyzed.name && analyzed.name !== '不明')
        ? analyzed.name
        : (regexFields.name
            ?? extractNameFallback([regexBodyText, attachText].join('\n'))
            ?? extractCandidateCode(subject)
            ?? '不明')
      // 「渋谷駅」のように 駅 サフィックスが付いたまま名前として取れたケースのみ除外
      // 駅名と同じ苗字（渋谷・大宮・藤沢等）は正当な人名のため除外しない
      const _bareRawName = _rawName.replace(/駅$/, '')
      const resolvedName = (_rawName !== '不明' && _bareRawName !== _rawName)
        ? '不明'
        : _rawName

      // AI空項目にregexフォールバックを適用
      const resolvedStation = analyzed.nearestStation || regexFields.nearestStation
      // ハードコードマップにない駅は DB を 1 件だけ問い合わせる
      let resolvedPrefecture = analyzed.prefecture || regexFields.prefecture
        || (resolvedStation ? await lookupStationPrefectureFromDb(resolvedStation) : null)
      // 最寄駅 DB 照合で都道府県を上書き（テキスト誤抽出対策。例: 署名欄の大阪 → 富士見台駅 → 東京都）(#90)
      if (resolvedStation) {
        const stationDbPref = await lookupStationPrefectureFromDb(resolvedStation)
        if (stationDbPref && stationDbPref !== resolvedPrefecture) {
          console.log(`[STATION_PREF_OVERRIDE] ${resolvedStation}: ${resolvedPrefecture} → ${stationDbPref}`)
          resolvedPrefecture = stationDbPref
        }
      }
      let resolvedExperienceYears = analyzed.experienceYears ?? regexFields.experienceYears
      // skillYearsフォールバック: Excel由来の実プロジェクト期間の方が正確なため、
      // 本文の記述（regex/AI）より大きい場合は常にExcel側を採用する
      // （本文に「〇〇経験N年」という一部内訳しか書かれておらず、Excel添付の実際の
      // プロジェクト履歴の方が長い、というケースが実在するため）
      // 優先順位: max-min日付スパン → _totalProjectMonths合計 → スキル最大月数
      if (Object.keys(excelSkillYears).length > 0) {
        const dateSpanMonths = excelSkillYears['_dateSpanMonths'] ?? null
        const totalProjectMonths = excelSkillYears['_totalProjectMonths'] ?? null
        const skillValues = Object.entries(excelSkillYears)
          .filter(([k]) => k !== '_totalProjectMonths' && k !== '_dateSpanMonths')
          .map(([, v]) => v)
        const maxSkillMonths = skillValues.length > 0 ? Math.max(...skillValues) : 0
        const estimatedMonths = dateSpanMonths ?? totalProjectMonths ?? (maxSkillMonths > 0 ? maxSkillMonths : null)
        if (estimatedMonths && estimatedMonths > 0) {
          const excelYears = estimatedMonths / 12
          // 本文に「経験年数：」等の専用ラベルからの明示的な自己申告値がある場合は、
          // 候補者本人の意図的な申告を優先し、Excel日付スパンで上書きしない
          if (resolvedExperienceYears == null || (!regexFields.experienceYearsIsDedicated && excelYears > resolvedExperienceYears)) {
            resolvedExperienceYears = excelYears
          }
        }
      }
      // サニティチェック: 年齢が判明している場合、経験年数が「年齢-15」を超える異常値
      // （結合セル崩れ等で日付範囲を誤解析し、実年齢よりずっと長い経験年数になってしまうケース）
      // を検知し、一旦クリアして下の年齢フォールバックに任せる。
      // 1年未満（セル分断で断片的な数値を誤って拾い、Math.round後に0年になるケースを含む）も
      // 同様に信頼できないため対象に含める（例: 0.3年 → 厳密な===0では素通りしてしまう）
      {
        const resolvedAgeForSanity = analyzed.age ?? regexFields.age
        if (resolvedExperienceYears != null && (resolvedExperienceYears < 1 || (resolvedAgeForSanity != null && resolvedExperienceYears > resolvedAgeForSanity - 15))) {
          resolvedExperienceYears = null
        }
      }
      // 年齢フォールバック: 経験年数が取れない場合、年齢から22を引いて推定（新卒22歳基準）
      if (resolvedExperienceYears == null) {
        const resolvedAge = analyzed.age ?? regexFields.age
        if (resolvedAge != null && resolvedAge >= 24 && resolvedAge <= 70) {
          const estimated = resolvedAge - 22
          resolvedExperienceYears = estimated
        }
      }
      const resolvedDesiredRate = analyzed.desiredRate || regexFields.desiredRate
      const resolvedAvailableFrom = analyzed.availableFrom || regexFields.availableFrom

      // 文章スキャンフェーズ: roles / industries / workStyle を文章から補完
      const proseFields = extractFromProse(regexBodyText, attachText)
      const resolvedRoles = (analyzed.roles?.length ?? 0) > 0
        ? analyzed.roles!
        : proseFields.roles
      const resolvedIndustries = (analyzed.industries?.length ?? 0) > 0
        ? analyzed.industries!
        : proseFields.industries
      const resolvedRemoteAvailable = analyzed.remoteAvailable
        || proseFields.workStyle === 'フルリモート'
        || proseFields.workStyle === 'リモート可'
        || proseFields.workStyle === 'リモート希望'
      // フルリモート希望: 常駐案件を避けマッチングスコアを下げるために使用
      const resolvedWantsFullRemote = proseFields.workStyle === 'フルリモート'
      // リモート勤務スタイル（表示用文字列）
      const remoteWorkStyleRaw = (() => {
        const t = bodyText + ' ' + attachText
        // 週X日パターンを優先抽出（リモート日数 or 出社日数）
        const weekM = t.match(/週(\d)[〜~～]?(\d?)日[　 ]?(?:程度)?(?:[　 ]?以内)?[^\n]{0,10}(?:リモート|在宅|テレワーク)|(?:リモート|在宅|テレワーク)[^\n]{0,10}週(\d)[〜~～]?(\d?)日/)
        if (weekM) {
          const d1 = weekM[1] || weekM[3]
          return `週${d1}日リモート可`
        }
        // 週X日出社パターン（「大阪週1出社可能」「週2日出社可」「出社頻度：週1回」等）
        const syukkM = t.match(/(?:週(\d)[〜~～]?(\d?)日[　 ]?(?:程度)?(?:の)?出社|出社[　 ]?週(\d)[〜~～]?(\d?)日|出社(?:頻度)?[：:\s　]*週(\d+)[〜~～]?(\d*)回?|週(\d+)[〜~～]?(\d*)回?(?:程度)?(?:[　 ]?以内)?[^\n]{0,5}出社)/)
        if (syukkM) {
          const d1 = syukkM[1] || syukkM[3] || syukkM[5] || syukkM[7]
          if (d1) return `週${d1}日出社可`
        }
        // 月X回出社パターン（「月1〜2回出社」「原則リモート（月1回程度出社）」）
        const tsukkiM = t.match(/月(\d)[〜~～]?(\d?)回?(?:程度)?(?:の)?出社|出社(?:頻度)?[：:\s　]*月(\d+)[〜~～]?(\d*)回?/)
        if (tsukkiM) {
          const d1 = tsukkiM[1] || tsukkiM[3]
          if (d1) return `月${d1}日出社可`
        }
        // 基本リモートパターン（「基本リモート・週1〜2回出社」等）→ 既に上記で拾えなかった場合
        if (/基本リモート|原則リモート|リモートベース|リモートメイン/.test(t)) {
          // 週回数の追加抽出を試みる
          const weekCount = t.match(/週(\d)[〜~～]?(\d?)回/)
          if (weekCount) return `週${weekCount[1]}日出社可`
          return 'リモート希望'
        }
        if (proseFields.workStyle === 'フルリモート') return 'フルリモート希望'
        if (proseFields.workStyle === 'リモート希望') return 'リモート希望'
        if (resolvedRemoteAvailable) return 'リモート可'
        return null
      })()
      // 本文のワークスタイル記載文（生フレーズ）＋ざっくりタグ（常駐可否）
      const workStyleNoteRaw = extractWorkStyleNote(bodyText, attachText)
      const workStyleTagRaw = deriveWorkStyleTag(workStyleNoteRaw)
      // 英語レベル抽出（ビジネス / 日常会話 / null）
      const englishLevelRaw = (() => {
        const t = bodyText + ' ' + attachText
        if (/英語.{0,15}(ビジネス|業務レベル|ネイティブ|英文メール|英語業務)|ビジネス.{0,10}英語|TOEIC[^\d]*[789]\d\d|英検[12]級|英検準1級/.test(t)) return 'business'
        if (/英語.{0,15}(日常会話|会話レベル)|日常会話.{0,10}英語|英会話|TOEIC[^\d]*[56]\d\d/.test(t)) return 'daily'
        return null
      })()
      // 派遣・常駐 OK/NG
      const hakenOkRaw = (() => {
        const t = bodyText + ' ' + attachText
        if (/派遣[^\n]{0,10}(不可|NG|×)|常駐[^\n]{0,10}(不可|NG|×)|業務委託のみ|フルリモート(のみ|必須|限定)/.test(t)) return false
        if (/派遣[^\n]{0,10}(可|OK|希望|対応)|常駐[^\n]{0,10}(可|OK|希望|対応)|SES[^\n]{0,10}(可|OK)|客先常駐[^\n]{0,10}可/.test(t)) return true
        return null
      })()

      // 雇用形態・立場（商流位置＋雇用形態の2次元）
      const employmentInfo = extractEmploymentType(bodyText, attachText)
      const employmentTypeRaw = employmentInfo.employmentType
      const commercialFlowRaw = employmentInfo.commercialFlow

      // ── AI必要性チェック用: フィールドごとの情報源を記録 ──────────────────
      // 'ai'=AI提供, 'regex'=正規表現補完, 'prose'=文章スキャン補完, 'none'=取得不可
      const _fieldSources: Record<string, string> = {
        name: (analyzed.name && analyzed.name !== '不明') ? 'ai'
          : regexFields.name ? 'regex'
          : extractNameFallback([regexBodyText, attachText].join('\n')) ? 'regex_initial'
          : extractCandidateCode(subject) ? 'regex_code'
          : 'none',
        nearestStation: analyzed.nearestStation ? 'ai' : regexFields.nearestStation ? 'regex' : 'none',
        prefecture:     analyzed.prefecture     ? 'ai' : regexFields.prefecture     ? 'regex' : 'none',
        experienceYears: analyzed.experienceYears != null ? 'ai' : regexFields.experienceYears != null ? 'regex' : 'none',
        desiredRate:     analyzed.desiredRate    ? 'ai' : regexFields.desiredRate    ? 'regex' : 'none',
        availableFrom:   analyzed.availableFrom  ? 'ai' : regexFields.availableFrom  ? 'regex' : 'none',
        roles:       (analyzed.roles?.length ?? 0) > 0      ? 'ai' : proseFields.roles.length > 0      ? 'prose' : 'none',
        industries:  (analyzed.industries?.length ?? 0) > 0 ? 'ai' : proseFields.industries.length > 0 ? 'prose' : 'none',
        remoteAvailable: analyzed.remoteAvailable ? 'ai' : proseFields.workStyle ? 'prose' : 'none',
        // summary は AI専用（regex代替不可）
        summary:    analyzed.summary ? 'ai' : 'none',
        // スキルはDB照合のみ（AI不使用）
        skills:     `db:${dbSkillNames.length}`,
      }
      // AI が実際に貢献したフィールド数（summary含む）
      const aiOnlyCount = Object.values(_fieldSources).filter(v => v === 'ai').length
      const regexSavedCount = Object.values(_fieldSources).filter(v => v.startsWith('regex') || v === 'prose').length
      console.log(
        `[ai_necessity] ai=${aiOnlyCount}フィールド regex/prose=${regexSavedCount}フィールド none=${Object.values(_fieldSources).filter(v => v === 'none').length}フィールド`,
        JSON.stringify(_fieldSources),
      )

      const dbPayload = {
        data_env: inboundDataEnv,
        name: resolvedName,
        email: null as string | null,
        phone: null as string | null,
        skills,
        experience_years: toExperienceYears(resolvedExperienceYears),
        raw_profile: {
          text: effectiveBody,
          summary: analyzed.summary ?? '',
          skillsByCategory: dbMatchedSkills.reduce((acc, s) => {
            if (!acc[s.category]) acc[s.category] = []
            acc[s.category].push(s.name)
            return acc
          }, {} as Record<string, string[]>),
          roles: resolvedRoles,
          industries: resolvedIndustries,
          nearestStation: resolvedStation,
          prefecture: resolvedPrefecture,
          availableRegions: analyzed.availableRegions ?? null,
          currentWorkLocation: analyzed.currentWorkLocation ?? null,
          remoteAvailable: resolvedRemoteAvailable,
          wantsFullRemote: resolvedWantsFullRemote || null,
          remoteWorkStyle: remoteWorkStyleRaw,
          workStyleNote: workStyleNoteRaw,
          workStyleTag: workStyleTagRaw,
          hakenOk: hakenOkRaw,
          englishLevel: englishLevelRaw,
          employmentType: employmentTypeRaw,
          commercialFlow: commercialFlowRaw,
          from, subject,
          emailReceivedAt,
          attachmentCount: allAttachments.length,
          // 元メールに実際に含まれていた添付の総数（画像/PDFに加えExcel/Word等も含む）
          sourceAttachmentCount: allAttachments.length + officeTextContents.length + unrecognizedAttachments.length,
                // Word/Excel/PDFのいずれとも判定されず無視された添付（未対応形式）の一覧。
                // 空なら undefined にして raw_profile を肥大化させない。
                unrecognizedAttachments: unrecognizedAttachments.length > 0 ? unrecognizedAttachments : undefined,
                // メール全体で正常にパース出来た添付の全ラベル一覧（候補者ごとの割当結果とは無関係）。
                // attachmentNames は「この候補者に割り当てられたものだけ」しか残らないため、
                // 「メールに実際何個添付があり、それぞれ何というファイル名だったか」を
                // 特定の1候補者レコードからでも確認できるようにするための共通診断情報。
                allParsedAttachmentLabels: officeTextContents.length > 0 ? officeTextContents.map(t => t.label) : undefined,
          excelParseNotes: excelParseNotes.length > 0 ? excelParseNotes : undefined,
          attachmentNames: [
            ...allAttachments.map(a => a.name ?? a.mimeType),
            ...officeTextContents.map(t => t.label),
          ],
          driveLinks: googleEntries.map(t => t.label),
          // ゾーンT: 本人割当エントリの台帳＋メール全体サマリー（invariantViolationsが空でなければどこかでこけている）
          pipeline_trace: ledger.serializeTrace(gateAssigned.map(e => e.entryId)),
          availableFrom: resolvedAvailableFrom,
          desiredProject: regexFields.desiredProject,
          age: regexFields.age,
          gender: regexFields.gender,
          nationality: regexFields.nationality,
          selfPR: extractSelfPR(body, attachText) ?? null,
          agentComment: extractAgentComment(body, attachText) ?? null,
          geminiParseFallback: parseFallback,
          // Excel/Word 添付テキスト（再解析時に skillYears を再抽出できるよう保存）
          attachmentText: officeTextContents.length > 0
            ? officeTextContents.map(t => t.content).join('\n').slice(0, 5000)
            : undefined,
          // Excel スキルシートの「スキルサマリ」セル（selfPR・agentComment と並列の独自フィールド）
          skillSummary: excelSkillSummary ?? undefined,
          skillYears: (() => {
            // _totalProjectMonths / _dateSpanMonths は経験年数推定用の内部キーなので表示用 skillYears からは除外
            const displayExcel = Object.fromEntries(
              Object.entries(excelSkillYears).filter(([k]) => k !== '_totalProjectMonths' && k !== '_dateSpanMonths')
            )
            // 名前後ろ括弧のスキル年数（#79）: 「K.T（Java 5年 / Python 3年）」形式
            const nameYears = regexFields.nameSkillYears ?? {}
            // skillYears キーを skill_master 名・候補者スキルに正規化
            const normalizeKeys = (sy: Record<string, number>): Record<string, number> => {
              if (Object.keys(sy).length === 0) return sy
              // 改行区切りの複合キーを個別スキルに分離（"Mac\nAWS" → "Mac":months, "AWS":months）
              const expanded: Record<string, number> = {}
              for (const [rawKey, months] of Object.entries(sy)) {
                if (rawKey.includes('\n')) {
                  for (const sub of rawKey.split('\n')) {
                    const s = sub.trim()
                    if (s.length < 2) continue
                    if (/^\([^)]+\)$/.test(s) || /^（[^）]+）$/.test(s)) continue
                    // 分離したスキルは最大値を採用（同じプロジェクトでの重複加算を防止）
                    expanded[s] = Math.max(expanded[s] ?? 0, months)
                  }
                } else {
                  expanded[rawKey] = Math.max(expanded[rawKey] ?? 0, months)
                }
              }
              const norm: Record<string, number> = {}
              const usedSkills = new Set<string>()
              for (const [rawKey, months] of Object.entries(expanded)) {
                const rawLower = rawKey.toLowerCase().replace(/\s+/g, '')
                let matched: string | null = null
                // 1. 候補者スキル名に完全一致（大文字小文字・スペース無視）
                for (const sn of dbSkillNames) {
                  const snLower = sn.toLowerCase().replace(/\s+/g, '')
                  if (snLower === rawLower) { matched = sn; break }
                }
                // 2. 候補者スキル名に部分一致（"SQL"⊂"SQL Server" 等）
                //    短い名前（≤2文字）は誤マッチしやすいため両辺とも3文字以上を要求
                if (!matched && rawLower.length > 2) {
                  for (const sn of dbSkillNames) {
                    if (usedSkills.has(sn)) continue
                    const snLower = sn.toLowerCase().replace(/\s+/g, '')
                    if (snLower.length <= 2) continue // "C" 等の短い名前は部分一致しない
                    if (snLower.includes(rawLower) || rawLower.includes(snLower)) {
                      matched = sn; break
                    }
                  }
                }
                // 3. skill_master alias → name が候補者スキルに含まれるか確認
                if (!matched) {
                  for (const sm of masterSkills) {
                    const smLower = sm.name.toLowerCase().replace(/\s+/g, '')
                    const aliasMatch = smLower === rawLower || sm.aliases.some(a => a.toLowerCase().replace(/\s+/g, '') === rawLower)
                    if (aliasMatch && dbSkillNames.includes(sm.name)) { matched = sm.name; break }
                  }
                }
                const key = matched ?? rawKey
                if (matched) usedSkills.add(matched)
                // MAX採用（加算すると複数ソースで同一スキルが重複カウントされる）
                // 上限: 360ヶ月（30年）— それ以上はデータ異常とみなしてキャップ
                const cappedMonths = Math.min(months, 360)
                norm[key] = Math.max(norm[key] ?? 0, cappedMonths)
              }
              return norm
            }
            // 本文・添付テキストの文章パターンからスキル年数を抽出（常に実行してマージ）
            // Excel/Word/nameYears が空のキーを補完する。重複キーはExcel/Word優先（後が上書き）
            const bodyYears = extractSkillYearsFromBodyText(bodyText + '\n' + attachText)
            if (Object.keys(displayExcel).length > 0) return normalizeKeys({ ...bodyYears, ...nameYears, ...displayExcel })
            if (Object.keys(wordSkillYearsForDisplay).length > 0) return normalizeKeys({ ...bodyYears, ...nameYears, ...wordSkillYearsForDisplay })
            if (Object.keys(nameYears).length > 0) return normalizeKeys({ ...bodyYears, ...nameYears })
            if (Object.keys(bodyYears).length > 0) return normalizeKeys(bodyYears)
            return undefined
          })(),
          // Excel スキルシートの JSON 化データ（HF Spaces 品質チェック用）
          jsonRows: attachmentParsedGrid?.source === 'excel' ? attachmentParsedGrid.rows : undefined,
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
        box_url: boxUrls[0] ?? null,
        box_status: boxUrls.length > 0 ? 'pending' : null,
        resume_url: resumeUrl,
        desired_rate: resolvedDesiredRate ?? null,
        from_company: sanitizeFromCompany(analyzed.fromCompany ?? regexFields.fromCompany),
      }

      // ── INSERT前の重複チェック（同一人物なら UPDATE して INSERT をスキップ）──
      // 従来: INSERT後にフラグを立てる → 古いレコードが7日でアーカイブされると誰も残らない問題
      // 新方式: INSERT前にチェック → 同一人物なら既存レコードを最新情報で更新 + created_at をリセット
      let existingCandidateId: string | null = null
      // 再解析時: target_candidate_id が指定されていれば、そのIDに強制 UPDATE（デdup スコアに依存しない）
      if (targetCandidateId) {
        existingCandidateId = targetCandidateId
        console.log(`[reanalyze] target_candidate_id 強制 UPDATE: ${targetCandidateId}`)
      }
      if (!existingCandidateId && resolvedName && resolvedName !== '不明') {
        // ステップ①: 同エージェント（同一 from）優先チェック
        // 　件名一致 → 同一メール確定。件名違い → 駅・都道府県・年齢・経験年数の2つ以上一致で同一人物
        const { data: sameAgentSingle } = await supabase
          .from('candidates')
          .select('id, raw_profile, experience_years')
          .eq('data_env', inboundDataEnv)
          .eq('name', resolvedName)
          .eq('duplicate_flag', false)
          .is('merged_into', null)
          .eq('raw_profile->>from', from)
          .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
          .limit(5)
        if (sameAgentSingle && sameAgentSingle.length > 0) {
          for (const s of sameAgentSingle) {
            const theirRp = s.raw_profile as any
            const sameSubject = theirRp?.subject === subject
            let attrMatches = 0
            const myStation = resolvedStation ?? null
            const theirStation = theirRp?.nearestStation ?? null
            if (myStation && theirStation && myStation === theirStation) attrMatches++
            const myPref = resolvedPrefecture ?? null
            const theirPref = theirRp?.prefecture ?? null
            if (myPref && theirPref && myPref === theirPref) attrMatches++
            const myAge = regexFields.age ?? null
            const theirAge = theirRp?.age ?? null
            if (myAge != null && theirAge != null && myAge === theirAge) attrMatches++
            const myExp = toExperienceYears(resolvedExperienceYears)
            const theirExp = (s as any).experience_years ?? null
            if (myExp != null && theirExp != null && Math.abs(myExp - theirExp) < 2) attrMatches++
            if (sameSubject || attrMatches >= 2) {
              existingCandidateId = s.id
              break
            }
          }
        }
      }
      // ステップ②: 別エージェント含む全候補でJaccard類似度チェック
      if (existingCandidateId === null && resolvedName && resolvedName !== '不明') {
        const { data: similar } = await supabase
          .from('candidates')
          .select('id, name, skills, raw_profile, experience_years')
          .eq('data_env', inboundDataEnv)
          .eq('name', resolvedName)
          .eq('duplicate_flag', false)
          .is('merged_into', null)
          .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
          .limit(5)
        if (similar && similar.length > 0) {
          for (const s of similar) {
            const myStation = resolvedStation ?? null
            const theirStation = (s.raw_profile as any)?.nearestStation ?? null
            // 駅が両方存在して異なる場合は別人と判断
            if (myStation && theirStation && myStation !== theirStation) {
              continue
            }
            // 都道府県が両方存在して異なる場合は別人と判断
            const myPref = resolvedPrefecture ?? null
            const theirPref = (s.raw_profile as any)?.prefecture ?? null
            if (myPref && theirPref && myPref !== theirPref) {
              continue
            }
            // 経験年数の差が5年以上の場合は別人と判断
            const myExp = toExperienceYears(resolvedExperienceYears)
            const theirExp = (s as any).experience_years ?? null
            if (myExp != null && theirExp != null && Math.abs(myExp - theirExp) >= 5) {
              continue
            }
            const mySkillSet = new Set(skills.map((sk: string) => sk.toLowerCase()))
            const theirSkills = new Set(((s.skills as string[]) || []).map((sk: string) => sk.toLowerCase()))
            const intersection = [...mySkillSet].filter(sk => theirSkills.has(sk)).length
            const union = new Set([...mySkillSet, ...theirSkills]).size
            if (union > 0 && intersection / union >= 0.4) {
              existingCandidateId = s.id
              console.log(`[dedup] 同一人物と判断 → UPDATE: ${resolvedName} jaccard=${(intersection / union).toFixed(2)} id=${s.id}`)
              break
            }
          }
        }
      }

      let savedCandidateId: string
      if (existingCandidateId) {
        // 既存レコードを最新情報で UPDATE（created_at をリセットして7日カウントを延長）
        const updatePayload: Record<string, unknown> = {
          skills,
          experience_years: toExperienceYears(resolvedExperienceYears),
          raw_profile: dbPayload.raw_profile,
          desired_rate: resolvedDesiredRate ?? null,
          created_at: new Date().toISOString(),
        }
        if (resumeUrl) updatePayload.resume_url = resumeUrl
        if (dbPayload.from_company) updatePayload.from_company = dbPayload.from_company
        if (boxUrls.length > 0) { updatePayload.box_url = boxUrls[0]; updatePayload.box_status = 'pending' }
        const { error: updateError } = await supabase
          .from('candidates')
          .update(updatePayload)
          .eq('id', existingCandidateId)
          .eq('data_env', inboundDataEnv)
        if (updateError) throw new Error(`候補者更新エラー: ${updateError.message}`)
        savedCandidateId = existingCandidateId
      } else {
        // 新規 INSERT
        const { data, error } = await supabase.from('candidates').insert(dbPayload).select().single()
        if (error) throw new Error(`候補者保存エラー: ${error.message}`)
        savedCandidateId = data.id
      }

      // candidate_skills に一括INSERT（DB照合結果のカテゴリを使用）
      const skillsPayload: { candidate_id: string; category: string; skill: string }[] = []
      for (const matched of dbMatchedSkills) {
        if (matched.name && matched.name.trim()) {
          skillsPayload.push({ candidate_id: savedCandidateId, category: matched.category, skill: matched.name.trim() })
        }
      }
      if (skillsPayload.length > 0) {
        await supabase.from('candidate_skills').delete().eq('candidate_id', savedCandidateId)
        const { error: skillsError } = await supabase.from('candidate_skills').insert(skillsPayload)
        if (skillsError) console.error('[candidate_skills INSERT error]', skillsError)
        else { /* スキル登録完了 */ }
      }

      // skill_master の match_count をインクリメント（fire and forget）
      if (dbSkillNames.length > 0) {
        const matchedIds = masterSkills
          .filter(s => dbSkillNames.includes(s.name))
          .map(s => s.id)
        if (matchedIds.length > 0) {
          supabase.rpc('increment_skill_match_counts', { skill_ids: matchedIds })
            .then(() => {})
            .catch(() => {}) // エラーはメイン処理に影響させない
        }
      }

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'candidate',
        model: 'no-ai',
        from_address: from,
        subject,
        ai_result: { ...analyzed, _field_sources: _fieldSources },
        prompt_length: 0,
        status: 'success',
        duration_ms: durationMs,
        linked_id: savedCandidateId,
        raw_body: decodeHtmlEntities(body).slice(0, 3000),
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      // Box URLがあればスプレッドシートに書き込む（失敗してもメイン処理は継続）
      if (boxUrls.length > 0) {
        await appendToBoxSpreadsheet(boxUrls)
      }

      // agent_companies に会社名・ドメイン・許可番号を upsert（fire and forget）
      {
        const emailDomain = from ? from.split('@')[1]?.toLowerCase().trim() : null
        const companyName = sanitizeFromCompany(analyzed.fromCompany ?? regexFields.fromCompany)
        const ownDomain = 'i-voice.co.jp'
        if (emailDomain && emailDomain !== ownDomain && !emailDomain.includes('gmail') && !emailDomain.includes('yahoo') && !emailDomain.includes('outlook') && !emailDomain.includes('demo.invalid')) {
          const { haken, shokai } = extractLicenseNumbers(body)
          const licenseStatus = haken && shokai ? 'both' : haken ? 'haken' : shokai ? 'shokai' : undefined
          const upsertPayload: Record<string, unknown> = {
            domain: emailDomain,
            company_name: companyName ?? undefined,
            source: 'email',
          }
          if (haken) { upsertPayload.haken_number = haken; upsertPayload.verified_at = new Date().toISOString(); upsertPayload.verified_by = 'email' }
          if (shokai) { upsertPayload.shokai_number = shokai; upsertPayload.verified_at = new Date().toISOString(); upsertPayload.verified_by = 'email' }
          if (licenseStatus) upsertPayload.license_status = licenseStatus
          supabase.from('agent_companies').upsert(upsertPayload, { onConflict: 'domain', ignoreDuplicates: false }).then(() => {}).catch(() => {})
        }
      }

      console.log(`[inbound] 人材登録完了: ${resolvedName} id=${savedCandidateId}`)
      await markEmailProcessed(supabase, dedupConfigKey)
      return new Response(
        JSON.stringify({
          ok: true,
          type: 'candidate',
          id: savedCandidateId,
          name: resolvedName,
          geminiParseFallback: parseFallback,
          boxUrls: boxUrls.length > 0 ? boxUrls : undefined,
        }),
        {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      )
    }

    // ── 案件メール ────────────────────────────────────────────
    if (type === 'project') {
      // app_config の inbound_project_enabled が 'true' でない場合はスキップ（デフォルト: 無効）
      const { data: projectEnabledRow } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'inbound_project_enabled')
        .maybeSingle()
      if (projectEnabledRow?.value !== 'true' && !forceProcess) {
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: 'PROJECT_INBOUND_DISABLED' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      tracePhase = 'project_regex_extract'
      const durationMs = 0

      // ── 人材解析と同様の前処理を適用 ──────────────────────────────────
      // 1. HTMLエンティティデコード（&#31292; → 稼 等、HTML形式メール対策）
      const bodyDecoded = decodeHtmlEntities(body)
      // 2. URL除去（https://.../cc.php 等がPHP/HTTPSに誤マッチするのを防止）
      const bodyNoUrl = stripUrlsForSkillMatching(bodyDecoded)
      // 3. 送信者署名除去（━━━/─── 等の区切り線以降を除去して住所・電話番号の誤マッチを防止）
      const bodyClean = stripSenderSignature(bodyNoUrl)

      const allProjectText = [subject, bodyClean].join('\n')

      // ── セパレータ検出（1メール内では同一文字が使われる傾向） ────────────
      // 最も多く出現するセパレータ文字を先頭で検出し、以降の処理で使い回す
      const SEP_CHARS: Array<[RegExp, string]> = [
        [/[＝=]{4,}/g, '[＝=]{4,}'],
        [/━{4,}/g, '━{4,}'],
        [/─{4,}/g, '─{4,}'],
        [/\*{4,}/g, '\\*{4,}'],
        [/={4,}/g, '={4,}'],
        [/-{4,}/g, '-{4,}'],
      ]
      let dominantSepPat = '[＝=━─*-]{4,}'
      let maxSepCount = 0
      for (const [cRe, pat] of SEP_CHARS) {
        const cnt = (bodyClean.match(cRe) ?? []).length
        if (cnt > maxSepCount) { maxSepCount = cnt; dominantSepPat = pat }
      }
      const SEP_LINE_RE = new RegExp(`^[ \\t\\u3000]*(${dominantSepPat})[ \\t\\u3000]*$`, 'm')

      // ── extractFieldTwoPhase で全フィールドを統一抽出 ──────────────────
      // 候補者解析と同じ関数を使うことで【X　Y】形式・X：形式・次行形式すべてに対応

      // 勤務地: 駅名のみの場合は inferPrefectureFromStation で都道府県を補完
      const workLocationRaw = extractFieldTwoPhase(
        ['場所', '場　所', '勤務地', '作業場所', '就業場所', '常駐先', '勤務先'],
        allProjectText, attachText,
        v => v.length >= 2,
        30,
      ) ?? PREFECTURES.find(p => allProjectText.includes(p)) ?? null
      let workLocation: string | null = workLocationRaw
      if (workLocationRaw && !PREFECTURES.some(p => workLocationRaw.includes(p))) {
        const pref = inferPrefectureFromStation(workLocationRaw)
          ?? await lookupStationPrefectureFromDb(workLocationRaw)
        if (pref) workLocation = `${pref} ${workLocationRaw}`
        else console.log('[station_unmapped]', workLocationRaw)
      }

      // リモート（条件分岐のためキーワード判定を維持）
      let remotePolicy: string | null = null
      const remotePolicyRaw = extractFieldTwoPhase(
        ['リモート', 'テレワーク', 'リモートワーク', '在宅', '出社'],
        allProjectText, attachText, undefined, 30,
      )
      if (remotePolicyRaw) remotePolicy = remotePolicyRaw
      else if (/フルリモート|完全リモート|100[%％]リモート/.test(allProjectText)) remotePolicy = 'フルリモート'
      else if (/リモート可|テレワーク可|在宅可/.test(allProjectText)) remotePolicy = 'リモート可'
      else if (/週[1-5１-５]日.*(?:リモート|在宅)|(?:リモート|在宅).*週[1-5１-５]日/.test(allProjectText)) remotePolicy = allProjectText.match(/週[1-5１-５]日.*(?:リモート|在宅)|(?:リモート|在宅).*週[1-5１-５]日/)?.[0] ?? 'リモート一部可'
      else if (/常駐|フル出社|出社必須/.test(allProjectText)) remotePolicy = '常駐'

      // 契約形態
      const contractRaw = extractFieldTwoPhase(
        ['契約形態', '契約', '就業形態', '雇用形態', '契約種別'],
        allProjectText, attachText, undefined, 30,
      )
      let contractType: string | null = contractRaw ?? null
      if (!contractType) {
        if (/業務委託/.test(allProjectText)) contractType = '業務委託'
        else if (/準委任/.test(allProjectText)) contractType = '準委任'
        else if (/派遣/.test(allProjectText)) contractType = '派遣'
        else if (/請負/.test(allProjectText)) contractType = '請負'
      }

      // クライアント（今まで null 固定だったが extractFieldTwoPhase で取得を試みる）
      const client = extractFieldTwoPhase(
        ['クライアント', 'エンド', 'クライアント名', '発注元', '顧客', 'エンドユーザー', '顧客名'],
        allProjectText, attachText,
        v => v.length >= 2 && !/^[0-9]+$/.test(v),
        50,
      ) ?? null

      // 募集人数
      const headcountRaw = extractFieldTwoPhase(
        ['募集人数', '人数', '募集数', '採用人数', '募集'],
        allProjectText, attachText,
        v => /\d/.test(v),
        10,
      )
      const headcount = headcountRaw
        ? (parseInt(headcountRaw.match(/\d+/)?.[0] ?? '', 10) || null)
        : null

      // 予算: extractFieldTwoPhase で生文字列を取得してからパース
      const budgetRaw = extractFieldTwoPhase(
        ['単価', '単　価', '報酬', '月額', '予算', '報酬単価', '金額', '金　額'],
        allProjectText, attachText, undefined, 50,
      )
      let budgetMin: number | null = null
      let budgetMax: number | null = null
      const parseBudget = (raw: string) => {
        const rangeM = raw.match(/(\d{2,3})\s*[〜~～]\s*(\d{2,3})\s*万/)
        if (rangeM) { budgetMin = parseInt(rangeM[1], 10); budgetMax = parseInt(rangeM[2], 10); return }
        const singleM = raw.match(/(\d{2,3})\s*万/)
        if (singleM) { const v = parseInt(singleM[1], 10); if (v >= 20 && v <= 300) budgetMax = v }
      }
      if (budgetRaw) {
        parseBudget(budgetRaw)
      } else {
        // フォールバック: 全文から数値パターンで探す
        const fallbackRaw = allProjectText.match(/(\d{2,3})\s*[〜~～]\s*(\d{2,3})\s*万/)
          ?? allProjectText.match(/(\d{2,3})\s*万(?:円)?(?:\/月|程度|以内|まで|〜|~|）|$|\s)/)
        if (fallbackRaw) parseBudget(fallbackRaw[0])
      }

      // 開始時期・終了日: extractFieldTwoPhase で生文字列を取得してからパース
      const timingRaw = extractFieldTwoPhase(
        ['時期', '時　期', '開始時期', '参画時期', '稼働時期', '開始', '参画開始', 'スタート'],
        allProjectText, attachText, undefined, 50,
      )
      let startDate: string | null = null
      let endDate: string | null = null
      if (timingRaw) {
        const rawNorm = timingRaw.trim().replace(/[　\s]+/g, '')
        // 「7月～2027年2月」→ startDate=7月, endDate=2027-02
        const rangeM3 = rawNorm.match(/(\d{1,2})月[〜~～※]?[^\d]*(\d{4})[年\/](\d{1,2})/)
        if (rangeM3) {
          const mo = parseInt(rangeM3[1], 10)
          const now = new Date()
          const yr = mo < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear()
          startDate = `${yr}-${String(mo).padStart(2, '0')}-01`
          endDate = `${rangeM3[2]}-${rangeM3[3].padStart(2, '0')}-01`
        } else {
          const yearMonthM = rawNorm.match(/(\d{4})[年\/\-](\d{1,2})月?/)
          if (yearMonthM) {
            startDate = `${yearMonthM[1]}-${yearMonthM[2].padStart(2, '0')}-01`
          } else {
            const moM = rawNorm.match(/(\d{1,2})月/)
            if (moM) {
              const mo = parseInt(moM[1], 10)
              const now = new Date()
              const yr = mo < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear()
              startDate = `${yr}-${String(mo).padStart(2, '0')}-01`
            } else if (/即日|即時|ASAP/i.test(rawNorm)) {
              const d2 = new Date()
              startDate = `${d2.getFullYear()}-${String(d2.getMonth()+1).padStart(2,'0')}-01`
            }
          }
        }
      }

      // タイトル（件名から【】を除去して整形。手入力等の汎用件名の場合は本文から抽出）
      let cleanTitle = subject.replace(/【[^】]*】/g, '').replace(/^[★☆●◆◇■□▼▲※・\s]+/, '').trim() || subject
      const GENERIC_SUBJECTS = ['手入力登録', '無題', 'no subject', 'test', 'テスト', '']
      if (GENERIC_SUBJECTS.some(s => cleanTitle.toLowerCase() === s.toLowerCase())) {
        // 検出済みセパレータを使ってタイトルを抽出
        const bodyLines = bodyClean.split(/\r?\n/)
        outer: for (let i = 0; i < bodyLines.length - 1; i++) {
          if (SEP_LINE_RE.test(bodyLines[i])) {
            for (let j = i + 1; j < Math.min(i + 6, bodyLines.length); j++) {
              // 【xxx】 を完全に除去してからタイトル候補を取得
              const cand = bodyLines[j]
                .replace(/【[^】]*】/g, '')
                .replace(/^[★☆●◆◇■□▼▲※・\s]+/, '')
                .replace(/[）\s]+$/, '')
                .trim()
              if (cand.length >= 5 && !SEP_LINE_RE.test(cand) && !/^[（(【]/.test(cand)) {
                cleanTitle = cand.slice(0, 80)
                break outer
              }
            }
          }
        }
        // 区切り線が見つからない場合は本文の最初の非空行をタイトルとして使用
        if (GENERIC_SUBJECTS.some(s => cleanTitle.toLowerCase() === s.toLowerCase())) {
          const firstMeaningfulLine = bodyLines.find(l => {
            const t = l.replace(/【[^】]*】/g, '').replace(/^[★☆●◆◇■□▼▲※・\s]+/, '').trim()
            return t.length >= 5 && !SEP_LINE_RE.test(t)
          })
          if (firstMeaningfulLine) {
            cleanTitle = firstMeaningfulLine
              .replace(/【[^】]*】/g, '')
              .replace(/^[★☆●◆◇■□▼▲※・\s]+/, '')
              .replace(/[）\s]+$/, '')
              .trim()
              .slice(0, 80)
          }
        }
      }

      // ── 案件スキル: 【スキル】セクション内に絞り込み + 工程語除外 ─────────
      // 「基本設計～テストの経験」等の工程記述からスキルが誤マッチするのを防ぐ
      // 【スキル】セクション限定で照合するため、工程名の除外は最小限にする
      // テスト/基本設計/保守開発 等はスキルとして有効なので除外しない
      const PROJECT_PROCESS_NOISE = new Set([
        'システム開発', '機能追加', '改修',
      ])
      let projectRequiredSkills = dbSkillNames.filter(s => !PROJECT_PROCESS_NOISE.has(s))
      let projectNiceToHaveSkills: string[] = []

      // \s は全角スペース(\u3000)にマッチしないため [ \t\u3000]* を使う
      const WS = '[ \\t\\u3000]*'  // 行頭の空白（半角スペース・タブ・全角スペース）
      const NEXT_HEADER_RE = new RegExp(`\\n${WS}【[^】]{1,20}】`)
      // 【スキル】セクション: 次の【...】ヘッダーまで
      const skillSectionM2 = (() => {
        const start = allProjectText.search(/【スキル[^】]*】/)
        if (start < 0) return null
        const afterStart = allProjectText.slice(start)
        const rest = afterStart.slice(afterStart.indexOf('】') + 1)
        const end = rest.search(NEXT_HEADER_RE)
        return { text: end >= 0 ? rest.slice(0, end) : rest }
      })()
      // スキル名 → エイリアスのマップ（aliases チェック用。"Visual Basic .NET" → VB.NET 対応）
      const skillAliasMap = new Map(masterSkills.map(s => [s.name, s.aliases]))
      // スペースなし比較 + エイリアス比較も追加（"Spring Boot" vs "Springboot" / "VB.NET" vs "Visual Basic .NET" 等の表記ゆれ対応）
      const matchesText = (s: string, text: string) => {
        const sl = s.toLowerCase()
        const tl = text.toLowerCase()
        if (tl.includes(sl) || tl.includes(sl.replace(/\s+/g, ''))) return true
        const aliases = skillAliasMap.get(s) ?? []
        return aliases.some(a => a && (tl.includes(a.toLowerCase()) || tl.includes(a.toLowerCase().replace(/\s+/g, ''))))
      }
      const skillFiltered = dbSkillNames.filter(s => !PROJECT_PROCESS_NOISE.has(s))

      /**
       * 共通ヘルパー: niceText から nice-to-have を決定し、
       * required = 本文全体スキル - (nice-to-have で本文required部に出てこないもの)
       * → タイトル・description にあるスキルも required に残る
       */
      const applySkillSections = (niceText: string) => {
        const niceSkills = niceText
          ? skillFiltered.filter(s => matchesText(s, niceText))
          : []
        // niceText にしか出てこないスキルだけ nice-to-have に移動
        // （本文の他の場所にも出てくるなら required に残す）
        const bodyExclNice = niceText ? allProjectText.replace(niceText, '') : allProjectText
        projectNiceToHaveSkills = niceSkills.filter(s => !matchesText(s, bodyExclNice))
        projectRequiredSkills = skillFiltered.filter(s => !projectNiceToHaveSkills.includes(s))
      }

      if (skillSectionM2) {
        const skillText = skillSectionM2.text
        const niceIdx = skillText.search(/[＜<]尚可[＞>]|尚可[：:]/)
        const niceText = niceIdx >= 0 ? skillText.slice(niceIdx) : ''
        applySkillSections(niceText)
      } else {
        // フォールバック: 「スキル：<スキル・条件>」形式（角括弧デリミタ）
        // 例: スキル：<スキル・条件> ～ <人物面> ～ <尚可> 形式のメール
        const angleSkillM = allProjectText.match(
          /(?:スキル[ \t\u3000]*[：:]\s*)?[＜<]スキル[・．]?条件[＞>]([\s\S]*)/
        )
        if (angleSkillM) {
          const sectionText = angleSkillM[1]
          const niceIdx = sectionText.search(/[＜<]尚可[＞>]|尚可[：:]/)
          const niceText = niceIdx >= 0 ? sectionText.slice(niceIdx) : ''
          applySkillSections(niceText)
        }
      }

      // ── description: 優先順で抽出 ─────────────────────────────────────
      let projectDescription = ''
      // 1. 【案件背景・概要】等のセクション
      const descSectionM = bodyClean.match(/【(?:案件背景[・．]?概要?|案件概要|概要|背景|プロジェクト概要)】[ \t\u3000]*\n?([\s\S]{10,400})/)
      if (descSectionM) {
        projectDescription = descSectionM[1].split(NEXT_HEADER_RE)[0].trim().slice(0, 300)
      }
      // 2. 【内　容】/【内容】セクション（日本語標準案件フォーマット）
      if (!projectDescription) {
        const contentStart = bodyClean.search(/【内[ \t\u3000]?容[ \t\u3000]?】/)
        if (contentStart >= 0) {
          const afterMarker = bodyClean.slice(contentStart)
          const markerEnd = afterMarker.indexOf('】') + 1
          const contentRest = afterMarker.slice(markerEnd)
          const nextHeader = contentRest.search(NEXT_HEADER_RE)
          const raw = nextHeader >= 0 ? contentRest.slice(0, nextHeader) : contentRest
          projectDescription = raw
            .replace(/[＜<][^＞>]+[＞>]/g, '')   // ＜体制＞等のサブ見出しを除去
            .replace(/^[ \t\u3000]+/gm, '')
            .trim()
            .slice(0, 300)
        }
      }
      // 2b. 内　容：（コロン形式）フォールバック — 「内　容：本文...」が複数行にわたる場合
      // 次のラベル行（2文字以上 + ：）が来るまで継続して取得
      if (!projectDescription) {
        const colonM = bodyClean.match(/(?:^|\n)内[ \t\u3000]?容[ \t\u3000]?[：:]([\s\S]*?)(?=\n[^\s\u3000].{1,15}[：:]|\n[【＜<]|$)/)
        if (colonM && colonM[1].trim().length >= 10) {
          projectDescription = colonM[1]
            .replace(/^[ \t\u3000]+/gm, '')
            .trim()
            .slice(0, 300)
        }
      }
      // 3. 【備　考】セクション: 【内容】があっても常に追記（マッチング有用情報を落とさない）
      const extractBiko = (): string => {
        const bikoStart = bodyClean.search(/【備[ \t\u3000]?考[ \t\u3000]?】/)
        if (bikoStart >= 0) {
          const afterBiko = bodyClean.slice(bikoStart)
          const markerEnd = afterBiko.indexOf('】') + 1
          const bikoRest = afterBiko.slice(markerEnd)
          const nextH = bikoRest.search(NEXT_HEADER_RE)
          return (nextH >= 0 ? bikoRest.slice(0, nextH) : bikoRest)
            .replace(/^[ \t\u3000]+/gm, '').trim().slice(0, 200)
        }
        const bikoMatch = bodyClean.match(/(?:備[ \t\u3000]?考|プロジェクト概要|案件概要)[：:]\s*([^\n]{10,200})/)
        return bikoMatch ? bikoMatch[1].trim() : ''
      }
      const bikoText = extractBiko()
      if (!projectDescription) {
        projectDescription = bikoText
      } else if (bikoText) {
        projectDescription = `${projectDescription}\n\n【備考】${bikoText}`.slice(0, 500)
      }
      // 4. 区切り線あり・スキルセクション除去後の先頭段落
      if (!projectDescription && /[＝=━─*]{4,}/.test(bodyClean)) {
        const bodyNoSkill = bodyClean.replace(new RegExp(`【スキル[^】]*】[\\s\\S]+?(?=${NEXT_HEADER_RE.source})`, 'm'), '')
        const bodyStripped = bodyNoSkill.replace(/^[＝=━─*]{4,}.*\n?/gm, '').trim()
        const noTitleBody = cleanTitle && bodyStripped.startsWith(cleanTitle.slice(0, 10))
          ? bodyStripped.slice(cleanTitle.length).replace(/^[\s\n]+/, '')
          : bodyStripped
        const candidate = noTitleBody.split(/\n{2,}/)[0].trim().slice(0, 300)
        if (candidate.length >= 20) projectDescription = candidate
      }
      // 区切り線なし・内容セクションなしの場合は空（元メール本文アコーディオンで確認可能）

      // ── 文章スキャン: 業界・役割を本文から補完（人材解析と同じ extractFromProse を流用）
      const proseResult = extractFromProse(bodyClean, attachText)
      const resolvedIndustry = proseResult.industries.length > 0
        ? proseResult.industries.join('・')
        : null
      // roleSummary: PROSE_ROLES から案件に馴染む役割（PL/PM/SE等）のみ採用
      const PROJECT_ROLE_LABELS = new Set(['PM・PMO', 'PL・テックリード', 'SE・設計', 'PG・実装', 'インフラ・SRE', 'データエンジニア', 'スクラムマスター'])
      const resolvedRoleSummary = proseResult.roles.filter(r => PROJECT_ROLE_LABELS.has(r)).join('・') || null

      // ── スキル別の必要経験年数（例: VB.NET 5年/2年, C#.NET 5年） ──────────
      const requiredSkillYears = extractRequiredSkillYears(
        allProjectText,
        projectRequiredSkills,
        masterSkills,
      )
      const result = {
        title: cleanTitle,
        client,
        description: projectDescription,
        requiredSkills: projectRequiredSkills,
        niceToHaveSkills: projectNiceToHaveSkills,
        requiredSkillYears,
        budgetMin,
        budgetMax,
        startDate,
        endDate,
        workLocation,
        remotePolicy,
        contractType,
        headcount,
        workload: null,
        settlementMin: null,
        settlementMax: null,
        roleSummary: resolvedRoleSummary,
        industry: resolvedIndustry,
      }
      tracePhase = 'project_regex_done'

      const projectObjects = normalizeToProjectObjects(result)
      if (projectObjects.length === 0) {
        throw new Error('案件解析結果が空、または形式が不正です（オブジェクトまたは配列を期待）')
      }

      const sharedRawMeta = {
        text: decodeHtmlEntities(body).slice(0, 10000),
        from,
        subject,
        emailReceivedAt,
        attachmentCount: allAttachments.length,
        // 元メールに実際に含まれていた添付の総数（画像/PDFに加えExcel/Word等も含む）
        sourceAttachmentCount: allAttachments.length + officeTextContents.length + unrecognizedAttachments.length,
                // Word/Excel/PDFのいずれとも判定されず無視された添付（未対応形式）の一覧。
                // 空なら undefined にして raw_profile を肥大化させない。
                unrecognizedAttachments: unrecognizedAttachments.length > 0 ? unrecognizedAttachments : undefined,
                // メール全体で正常にパース出来た添付の全ラベル一覧（候補者ごとの割当結果とは無関係）。
                // attachmentNames は「この候補者に割り当てられたものだけ」しか残らないため、
                // 「メールに実際何個添付があり、それぞれ何というファイル名だったか」を
                // 特定の1候補者レコードからでも確認できるようにするための共通診断情報。
                allParsedAttachmentLabels: officeTextContents.length > 0 ? officeTextContents.map(t => t.label) : undefined,
        excelParseNotes: excelParseNotes.length > 0 ? excelParseNotes : undefined,
        attachmentNames: [
          ...allAttachments.map((a) => a.name ?? a.mimeType),
          ...officeTextContents.map((t) => t.label),
        ],
        driveLinks: googleEntries.map((t) => t.label),
        batchSize: projectObjects.length,
      }

      const insertRows = projectObjects.map((raw, batchIndex) => {
        const requiredSkills = dedupeTrimmedSkills(raw.requiredSkills)
        const niceToHaveSkills = dedupeTrimmedSkills(raw.niceToHaveSkills)
        const description = typeof raw.description === 'string' ? raw.description : ''
        const matchWeights = calcProjectWeightsForEdge({
          title: typeof raw.title === 'string' ? raw.title : null,
          description,
          role_summary: strOrNull(raw.roleSummary),
          required_skills: requiredSkills,
          remote_policy: strOrNull(raw.remotePolicy),
        })
        const headcount = parseOptionalInt(raw.headcount, 1, 500)
        const settlementMin = parseOptionalInt(raw.settlementMin, 0, 744)
        const settlementMax = parseOptionalInt(raw.settlementMax, 0, 744)
        const title = strOrNull(raw.title) ?? '案件'
        const budgetMin = parseOptionalNumber(raw.budgetMin)
        const budgetMax = parseOptionalNumber(raw.budgetMax)

        return {
          data_env: inboundDataEnv,
          title,
          client: strOrNull(raw.client),
          description,
          required_skills: requiredSkills,
          budget_min: budgetMin,
          budget_max: budgetMax,
          start_date: parseIsoDateOnly(raw.startDate),
          end_date: parseIsoDateOnly(raw.endDate),
          work_location: strOrNull(raw.workLocation),
          remote_policy: strOrNull(raw.remotePolicy),
          contract_type: strOrNull(raw.contractType),
          headcount,
          workload: strOrNull(raw.workload),
          settlement_min: settlementMin,
          settlement_max: settlementMax,
          role_summary: strOrNull(raw.roleSummary),
          industry: strOrNull(raw.industry),
          raw_data: {
            ...sharedRawMeta,
            batchIndex,
            niceToHaveSkills,
            matchWeights,
            requiredSkillYears: (raw as { requiredSkillYears?: Record<string, number[]> }).requiredSkillYears ?? {},
            aiAnalysis: {
              ...raw,
              requiredSkills,
              niceToHaveSkills,
            },
          },
          created_by: 'make-inbound',
        }
      })

      const { data: insertedRows, error } = await supabase.from('projects').insert(insertRows).select() as { data: Array<{ id: string; title: string }> | null; error: { message: string } | null }

      if (error) throw new Error(`案件保存エラー: ${error.message}`)
      if (!insertedRows?.length) throw new Error('案件保存後に行が返りませんでした')

      const logResults = await Promise.all(
        insertedRows.map((row, i) =>
          supabase.from('ai_logs').insert({
            type: 'project',
            model: 'no-ai',
            from_address: from,
            subject,
            ai_result: { ...projectObjects[i], batchIndex: i, batchSize: projectObjects.length },
            prompt_length: 0,
            status: 'success',
            duration_ms: durationMs,
            linked_id: row.id,
            raw_body: decodeHtmlEntities(body).slice(0, 3000),
          })
        ),
      )
      for (const lr of logResults) {
        if (lr.error) console.error('[ai_logs INSERT error]', lr.error)
      }

      console.log(
        `[inbound] 案件登録完了: ${insertedRows.length}件 — ${insertedRows.map((r) => r.title).join(', ')}`,
      )
      await markEmailProcessed(supabase, dedupConfigKey)
      return new Response(
        JSON.stringify({
          ok: true,
          type: 'project',
          count: insertedRows.length,
          ids: insertedRows.map((r) => r.id),
          titles: insertedRows.map((r) => r.title),
          id: insertedRows[0].id,
          title: insertedRows[0].title,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        error: `不明な type: ${type}`,
        code: 'UNKNOWN_TYPE',
        hint: 'type は candidate / human / project のいずれか（省略時は candidate）',
        receivedKeys: rawKeys,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[inbound-email] FATAL', {
      rid: traceRid || '(unset)',
      phase: tracePhase,
      error: message,
      stack: stack ?? '',
    })

    try {
      const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))
      // 処理失敗時はDEDUPハッシュを削除して次回再試行できるようにする
      await unmarkEmailProcessed(supabase, dedupConfigKey)
      await supabase.from('ai_logs').insert({
        type: 'unknown',
        model: 'no-ai',
        ai_result: {},
        status: 'error',
        error_message: message,
      })
    } catch { /* ログ保存失敗は握りつぶす */ }

    const soft = isInboundMakeSoftFail()
    const httpStatus = soft ? 200 : 500
    return new Response(
      JSON.stringify({
        ok: false,
        error: message,
        rid: traceRid || null,
        phase: tracePhase,
        makeSoftFail: soft,
      }),
      {
        status: httpStatus,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )
  }
})