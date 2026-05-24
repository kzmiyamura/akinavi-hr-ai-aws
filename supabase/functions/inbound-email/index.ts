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
]
const EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
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
  // 0〜60年の範囲外はAIのハルシネーション（職歴計算ミス等）として null に落とす
  if (years < 0 || years > 60) return null
  return years
}

/**
 * セクション見出しリストからテキストを抽出するユーティリティ。
 * 最大500文字・複数セクション発見時は \n\n で結合。見つからない場合は null。
 */
function extractSectionsByLabels(text: string, labels: string[]): string | null {
  if (!text.trim()) return null
  const prefix = '[【◆■●▼★◎※◇]?'
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
    content = content.trim().slice(0, 500)
    if (content.length >= 5) found.push(content)
  }
  if (found.length === 0) return null
  return found.join('\n\n').slice(0, 500)
}

/** 候補者本人の自己PR（自己PR / PR / アピールポイント / 強み 等）を抽出する。
 * スプレッドシート等の添付データは対象外（誤マッチ防止）。 */
function extractSelfPR(body: string, _attachText: string): string | null {
  return extractSectionsByLabels(body, [
    '自己PR', 'PR', 'アピールポイント', '特徴・強み', '強み', '紹介文',
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
  ])
}

/** 自社名（受信側）として登録されてしまうことを防ぐ会社名リスト */
const OWN_COMPANY_NAMES = ['株式会社ボイス', 'i-voice', 'アキナビ', 'akinavi', '株式会社アキナビ']

function sanitizeFromCompany(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  // 自社名・空文字は null に落とす
  if (!trimmed) return null
  for (const own of OWN_COMPANY_NAMES) {
    if (trimmed.toLowerCase().includes(own.toLowerCase())) return null
  }
  return trimmed
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

/** 1 リクエストを追跡（Supabase ログで rid で検索） */
function pipe(rid: string, phase: string, detail?: Record<string, unknown>) {
  console.log(`[PIPE] rid=${rid} phase=${phase}`, detail ?? {})
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
  '調布': '東京都', '新宿西口': '東京都', '四ツ谷': '東京都',
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

/**
 * 駅名（"八街駅" "八街" 等）から都道府県を推定する。
 * 不一致時は null を返す。
 */
export function inferPrefectureFromStation(station: string | null | undefined): string | null {
  if (!station) return null
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim()
  if (!cleaned) return null
  return STATION_TO_PREFECTURE[cleaned] ?? null
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
        : `(?<![a-zA-Z0-9_#])${escaped}(?![a-zA-Z0-9_])`

      const regex = new RegExp(pattern, 'gi')
      if (regex.test(matchTarget)) {
        matched.push({ name: skill.name, category: skill.category })
        if (!isCert) {
          remaining = remaining.replace(new RegExp(pattern, 'gi'), ' ')
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
    // 区切り文字に挟まれたパターン
    const delimRe = new RegExp(
      `(?:^|[,，/／・\\t\\n\\r])\\s*(${escaped})\\s*(?=[,，/／・\\t\\n\\r]|$)`,
      'gi',
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

  console.log(`[skill_rating] スキルシート形式を検出 (評価行 ${ratingLineCount} 行)`)

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
    if (v && v.length >= 1) return v
  }

  // ② イニシャル: 大文字2文字の間にスペース・・.のいずれか（例: T・Y / T Y / K.M）
  // 直後が英数字でなければマッチ（】 _ スペース 末尾 等）
  const initialMatch = text.match(/\b([A-Z][　 ・.][A-Z])(?![a-zA-Z0-9])/)
  if (initialMatch) return initialMatch[1]

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
  const SEP     = `(?:[：:\\t】◆◇●■▼★]|　+| {2,})`
  const SEP_ATT = `(?:[：:\\t,，】◆◇●■▼★]|　+| {2,})`

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
    new RegExp(`(?:${esc})(?:（[^）]{1,20}）)?[　 ]?${sep}[　 ]?([^\\n,，]{1,${maxLen}})`, 'i')

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
    const labelOnly1b = new RegExp(`^[　 ]*(?:${esc})[　 ]?[：:,，]?[　 ]*$`, 'i')
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
    const labelOnly  = new RegExp(`^[　 ]*(?:${esc})[　 ]?[：:,，]?[　 ]*$`, 'i') // ラベルのみ行

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
      if (labelOnly.test(line)) {
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
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
  desiredRate: string | null
  availableFrom: string | null
  desiredProject: string | null
  fromCompany: string | null
} {
  // ── 氏名 ──────────────────────────────────────────────────────
  // Phase3 は日本語の姓名（2文字〜）も有効なので phase3MinLen=2
  const rawName = extractFieldTwoPhase(
    ['氏名等','氏名','名前','候補者名','お名前','フルネーム','ご氏名','氏　名'],
    bodyText, attachText,
    v => v.length >= 1 && !/^\d+$/.test(v),
    20,
    2,
  )
  // 先頭の区切り文字（：: 等）を除去（「：T.B（27）」→「T.B（27）」）
  const cleanedName = rawName ? rawName.replace(/^[：:\s　]+/, '').trim() || null : null
  // 名前から年齢・性別を抽出して除去
  // パターン1: (34歳/男性) (34才/女性) - スラッシュ区切り一体型
  // パターン2: 56才(男性) - 分離型
  let age: number | null = null
  let gender: string | null = null
  let nameStripped = cleanedName || ''
  // パターンA: (26歳/男性) (26歳/男性/日本) (26歳：男性) — 年齢が先・末尾に/国籍等があっても可
  const agGenderUnified = nameStripped.match(/[\(（](\d{2})[才歳][ 　]*[/／：:][ 　]*(男性|女性|男|女)(?:[/／]([^)）]*))?[\)）]/)
  // パターンB: (男性/40歳) (女性/34歳) — 性別が先
  const genderAgeUnified = !agGenderUnified ? nameStripped.match(/[\(（](男性|女性|男|女)[ 　]*[/／][ 　]*(\d{2})[才歳][\)）]/) : null
  let nationality: string | null = null
  if (agGenderUnified) {
    age = parseInt(agGenderUnified[1], 10)
    gender = agGenderUnified[2]
    if (agGenderUnified[3]?.trim()) nationality = agGenderUnified[3].trim()
    nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[才歳][ 　]*[/／：:][ 　]*(?:男性|女性|男|女)(?:[/／][^)）]*)?[\)）]/, '').trim()
  } else if (genderAgeUnified) {
    gender = genderAgeUnified[1]
    age = parseInt(genderAgeUnified[2], 10)
    nameStripped = nameStripped.replace(/[\s　]?[\(（](?:男性|女性|男|女)[ 　]*[/／][ 　]*\d{2}[才歳][\)）]/, '').trim()
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
  }

  // ── ラベルなし 名前+年齢+性別 フォールバック ─────────────────────
  // 「■C-TN（44歳 / 男性）」のようにラベルなしで氏名・年齢・性別が記載されている場合
  // name/age/gender のいずれかが未取得なら全文スキャンで補完する
  let name: string | null = nameStripped || null
  if (!name || age === null || gender === null) {
    const allTextForName = bodyText + '\n' + attachText
    // 行頭デコレータ（任意）＋名前＋（年齢 / 性別）パターン — 年齢先
    const noLabelPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([^\d\s　（(\n【]{1,20})[ 　]?[（(](\d{2})[才歳][ 　]*[/／：: ][ 　]*(男性|女性|男|女)(?:[/／][^)）]*)?[）)]/m
    // 行頭デコレータ（任意）＋名前＋（性別 / 年齢）パターン — 性別先
    const noLabelPatGF = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([^\d\s　（(\n【]{1,20})[ 　]?[（(](男性|女性|男|女)[ 　]*[/／][ 　]*(\d{2})[才歳][）)]/m
    const nlM = allTextForName.match(noLabelPat)
    const nlMGF = !nlM ? allTextForName.match(noLabelPatGF) : null
    if (nlM) {
      if (!name)           name   = nlM[1].trim() || null
      if (age === null)    age    = parseInt(nlM[2], 10)
      if (gender === null) gender = nlM[3]
    } else if (nlMGF) {
      if (!name)           name   = nlMGF[1].trim() || null
      if (gender === null) gender = nlMGF[2]
      if (age === null)    age    = parseInt(nlMGF[3], 10)
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
  // 国籍除去後のnameStrippedで上書き（フォールバックで取得済みなら維持）
  name = name || nameStripped || null

  // ── ラベルあり別行フォールバック（年齢：30歳 / 性別：女性 / 国籍：中国）─
  // 名前から取れなかった場合に本文ラベルから補完する
  if (age === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/年\s*[　 ]*齢\s*[：:]\s*(\d{2})[才歳]/)
    if (m) age = parseInt(m[1], 10)
  }
  if (gender === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/性\s*[　 ]*別\s*[：:]\s*(男性|女性|男|女)/)
    if (m) gender = m[1]
  }
  if (!nationality) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/国\s*[　 ]*籍\s*[：:]\s*([^\s\n、。]{1,15})/)
    if (m) nationality = m[1].trim()
  }

  // ── 最寄駅 ────────────────────────────────────────────────────
  // 「渋谷」「大阪」など2文字の駅名もあるので phase3MinLen=2
  let nearestStation = extractFieldTwoPhase(
    ['最寄り?駅','最寄駅','最寄り?','沿線','通勤駅'],
    bodyText, attachText,
    v => /[駅線]$/.test(v) || v.length <= 10,
    15,
    2,
  )
  // ラベルなしフォールバック: 「○○駅徒歩N分」や「○○駅 」
  if (!nearestStation) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/([^\s,、。（）「」【】\t]{1,10}駅)(?:[\s　_\-）」】徒歩]|$)/)
    if (m) nearestStation = m[1].trim()
  }
  // 後処理: ラベル自体が値になっているケースを除外
  // 例: 「最寄駅」「イニシャル+最寄駅」「最寄：北13条東駅」→ 実駅名のみに修正
  if (nearestStation) {
    // 「最寄：北13条東駅」のようにコロン区切りで前半がラベルの場合、後半だけ取る
    const colonMatch = nearestStation.match(/[：:](.+駅.*)$/)
    if (colonMatch) nearestStation = colonMatch[1].trim()
    // ラベルそのものや template text は除外
    if (/^(最寄り?駅?|沿線|通勤駅|イニシャル|代表者|最寄り?$)/.test(nearestStation)
      || nearestStation.includes('イニシャル')
      || nearestStation.includes('最寄駅')) {
      nearestStation = null
    }
    // 「西武池袋線　飯能駅」→「飯能駅」（路線名+駅名 → 駅名だけ取る）
    if (nearestStation) {
      const stationOnly = nearestStation.match(/([^\s　]{2,12}駅)$/)
      if (stationOnly && stationOnly[1] !== nearestStation) {
        nearestStation = stationOnly[1]
      }
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
    prefecture = PREFECTURES.find(p => allText.includes(p)) ?? null
  }
  // 最寄駅から推定できる都道府県があれば最優先で採用する。
  // 送信者署名（東京都町田市等）由来の誤判定を上書きするため、
  // station 推定が一致した場合のみ駅由来を使う。
  const stationPrefecture = inferPrefectureFromStation(nearestStation)
  if (stationPrefecture) {
    if (!prefecture || prefecture !== stationPrefecture) {
      console.log(`[prefecture] 駅由来で上書き: ${prefecture ?? 'null'} → ${stationPrefecture} (station=${nearestStation})`)
      prefecture = stationPrefecture
    }
  }

  // ── 経験年数 ──────────────────────────────────────────────────
  let experienceYears: number | null = null
  const expPatterns = [
    /(?:IT|エンジニア|開発|プログラム|システム|設計|インフラ|クラウド)歴\s*[約]?\s*(\d+)\s*年/,
    /経験[：:\s]*[約]?\s*(\d+)\s*年/,
    /(\d+)\s*年[以上間程度]*(?:の)?(?:経験|実務|開発|IT|エンジニア)/,
    /(?:経験年数|開発経験)[：:]\s*[約]?\s*(\d+)年/,
    /(?:社会人歴|就労歴)[：:\s]*(\d+)年/,
  ]
  const allText = bodyText + '\n' + attachText
  for (const p of expPatterns) {
    const m = allText.match(p)
    if (m) {
      const y = parseInt(m[1], 10)
      if (y > 0 && y <= 60) { experienceYears = y; break }
    }
  }

  // ── 希望単価 ──────────────────────────────────────────────────
  let desiredRate: string | null = extractFieldTwoPhase(
    ['希望単価','目安単価','単価','単金','単　金','単 金','希望報酬','希望月額','希望料金'],
    bodyText, attachText,
    v => /\d/.test(v),
    20,
  )
  if (!desiredRate) {
    const rateM = allText.match(
      /(?:希望[単]?価|単価)[：:\s]*(\d{2,3})\s*万\s*円?(?:以上|\/月|程度|台|〜|~)?/
    ) ?? allText.match(/(\d{2,3})\s*万\s*円?(?:以上|\/月|程度)/)
    if (rateM) {
      const amount = parseInt(rateM[1], 10)
      if (amount >= 20 && amount <= 300) {
        const raw = rateM[0]
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
  // メール署名エリア（末尾1200文字）から会社名を抽出。
  // 宛先側の会社名（〇〇御中・〇〇様）は除外。
  let fromCompany: string | null = null
  const allBodyText = bodyText + '\n' + attachText
  const sigArea = allBodyText.slice(-1200)
  // 「株式会社XXX」先頭パターン
  const mPre = sigArea.match(/(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)([\S]{2,20})/)
  if (mPre) fromCompany = sanitizeFromCompany(`${mPre[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]}${mPre[1]}`)
  // 「XXX株式会社」末尾パターン（前述で取れなかった場合）
  if (!fromCompany) {
    const mPost = sigArea.match(/([\S]{2,20})(?:株式会社|有限会社|合同会社)/)
    if (mPost) fromCompany = sanitizeFromCompany(`${mPost[1]}${mPost[0].match(/株式会社|有限会社|合同会社/)?.[0]}`)
  }

  return { name, age, gender, nationality, nearestStation, prefecture, experienceYears, desiredRate, availableFrom, desiredProject, fromCompany }
}

/**
 * 文章スキャンフェーズ（ProseExtract）
 *
 * ラベル-値ペアでは取れない roles / industries / workStyle を対象に、
 * 「文章的な行」（20文字超 or 読点・句点を含む）からキーワードリストで抽出する。
 * AI が空で返した場合のフォールバックとして呼び出す。
 */

const PROSE_ROLES: Array<{ re: RegExp; label: string }> = [
  { re: /PM|プロジェクト[　 ]?マネージャー/,           label: 'プロジェクトマネージャー' },
  { re: /PL|プロジェクト[　 ]?リーダー/,               label: 'プロジェクトリーダー' },
  { re: /TL|テックリード|テック[　 ]?リード/,           label: 'テックリード' },
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
  { re: /要件定義/,                                    label: '要件定義' },
  { re: /基本設計/,                                    label: '基本設計' },
  { re: /詳細設計/,                                    label: '詳細設計' },
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
  const proseLines = allText.split(/\r?\n/).filter(
    l => (l.length > 20 || /[、。]/.test(l)) && !isPhaseTableHeader(l),
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

  console.log(`[prose_extract] roles=${roles.length} industries=${industries.length} workStyle=${workStyle ?? 'null'}`)
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
async function extractWordText(base64: string): Promise<string> {
  try {
    const mammothMod = npmDefault(await import('npm:mammoth@1.8.0'))
    const extractRawText = (mammothMod as { extractRawText?: (o: Record<string, unknown>) => Promise<{ value?: string }> })
      .extractRawText
    if (!extractRawText) throw new Error('mammoth.extractRawText がありません')
    const bytes = base64ToUint8Array(base64)
    if (bytes.byteLength === 0) throw new Error('Word添付のBase64が空です')

    // mammoth は実行環境により受け付けるキーが違うことがあるためフォールバックする
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const r1 = await extractRawText({ arrayBuffer: ab })
      return r1.value ?? ''
    } catch (e1) {
      console.warn('[Word] arrayBuffer 経路失敗、buffer 経路へフォールバック', e1)
      // Node互換ランタイムでは Buffer が使えることが多い
      const Buf = (globalThis as unknown as { Buffer?: { from: (u: Uint8Array) => unknown } }).Buffer
      if (Buf) {
        const r2 = await extractRawText({ buffer: Buf.from(bytes) as unknown })
        return r2.value ?? ''
      }
      const r3 = await extractRawText({ buffer: bytes as unknown })
      return r3.value ?? ''
    }
  } catch (e) {
    console.warn('[Word] mammoth失敗、.doc バイナリ抽出へフォールバック', e)
    // .doc（旧バイナリ形式）フォールバック
    const bytes = base64ToUint8Array(base64)
    return extractDocRawText(bytes)
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

/** Excel(.xlsx/.xls)をCSVテキストに変換してクレンジング（最初の3シートまで） */
async function extractExcelText(base64: string): Promise<string> {
  try {
    const XLSX = npmDefault(await import('npm:xlsx@0.18.5')) as {
      read: (data: Uint8Array, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
      utils: { sheet_to_csv: (sheet: unknown) => string }
    }
    const bytes = base64ToUint8Array(base64)
    const workbook = XLSX.read(bytes, { type: 'array' })
    const texts: string[] = []
    // スキル・経歴関連のシートを優先、それ以外を後ろに（最大3シート）
    const PRIORITY_SHEET_KEYWORDS = ['スキル', '経歴', '職務', 'スキルシート', 'skill', 'career', 'profile', '人材']
    const sortedSheetNames = [...workbook.SheetNames].sort((a, b) => {
      const aPri = PRIORITY_SHEET_KEYWORDS.some(kw => a.toLowerCase().includes(kw.toLowerCase())) ? 0 : 1
      const bPri = PRIORITY_SHEET_KEYWORDS.some(kw => b.toLowerCase().includes(kw.toLowerCase())) ? 0 : 1
      return aPri - bPri
    })
    for (const sheetName of sortedSheetNames.slice(0, 3)) {
      const sheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(sheet)
      if (csv.trim()) {
        const cleansed = cleanseExcelCsv(csv)
        texts.push(`--- シート: ${sheetName} ---\n${cleansed}`)
      }
    }
    const result = texts.join('\n\n')
    console.log(`[Excel] 抽出完了 totalLen=${result.length}`)
    return result
  } catch (e) {
    console.warn('[Excel] テキスト抽出失敗', e)
    return ''
  }
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

/** 本文中の Google Drive / Sheets / Docs リンクを検出してコンテンツを取得 */
async function fetchGoogleLinks(body: string): Promise<{
  textContents: { label: string; content: string }[]
  pdfAttachments: Attachment[]
}> {
  const textContents: { label: string; content: string }[] = []
  const pdfAttachments: Attachment[] = []

  const sheetsMatchesPreview = [...body.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{25,})[^\s]*/g)]
  const docsMatchesPreview = [...body.matchAll(/https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{25,})/g)]
  const driveMatchesPreview = [...body.matchAll(/https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{25,})/g)]
  console.log('[STEP4 fetchGoogleLinks] 開始', {
    bodyLen: body.length,
    linkCounts: { sheets: sheetsMatchesPreview.length, docs: docsMatchesPreview.length, drive: driveMatchesPreview.length },
  })

  // Google Sheets → CSV
  const sheetsMatches = sheetsMatchesPreview
  for (const match of sheetsMatches) {
    const id = match[1]
    const gidMatch = match[0].match(/[?&]gid=(\d+)/)
    const gid = gidMatch ? gidMatch[1] : null
    const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
    try {
      const res = await fetchWithTimeout(exportUrl)
      if (res.ok) {
        textContents.push({ label: `Googleスプレッドシート(${id})`, content: await res.text() })
      } else {
        // フォールバックDLは認証が必要なSheetsではHTMLゴミを返すためスキップ
        console.warn(`[DriveLink] Sheetsエクスポート失敗(${res.status}): ${id} - スキップ（公開設定を確認してください）`)
      }
    } catch (e) { console.warn(`[DriveLink] Sheets fetch error: ${id}`, e) }
  }

  // Google Docs → plain text
  const docsMatches = docsMatchesPreview
  for (const match of docsMatches) {
    const id = match[1]
    const exportUrl = `https://docs.google.com/document/d/${id}/export?format=txt`
    try {
      const res = await fetchWithTimeout(exportUrl)
      if (res.ok) {
        textContents.push({ label: `Googleドキュメント(${id})`, content: await res.text() })
      } else {
        console.warn(`[DriveLink] Docs取得失敗(${res.status}): ${id}`)
      }
    } catch (e) { console.warn(`[DriveLink] Docs fetch error: ${id}`, e) }
  }

  // Google Drive ファイル → PDF / テキスト / Excel / Word
  // ポートフォリオ等、経歴書以外のファイルはスキップ
  const DRIVE_SKIP_KEYWORDS = ['ポートフォリオ', '作品集', 'portfolio', 'Portfolio']
  const driveMatches = driveMatchesPreview
  for (const match of driveMatches) {
    const id = match[1]
    const urlIndex = match.index ?? 0
    const preceding = body.slice(Math.max(0, urlIndex - 150), urlIndex)
    const shouldSkip = DRIVE_SKIP_KEYWORDS.some(kw => preceding.includes(kw))
    if (shouldSkip) {
      continue
    }
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${id}`
    try {
      // ファイルサイズが大きい場合があるので 20 秒に延長
      const res = await fetchWithTimeout(downloadUrl, 20000)
      if (res.ok) {
        const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim()
        // content-disposition からファイル名を取得（ログ・ラベル用）
        const cd = res.headers.get('content-disposition') ?? ''
        const filenameMatch = cd.match(/filename[^;=\n]*=\s*["']?([^"';\n]+)["']?/)
        const filename = filenameMatch ? decodeURIComponent(filenameMatch[1].trim()) : `drive_${id}`

        const isExcel = EXCEL_MIME.includes(ct) || ct.includes('spreadsheet') || ct.includes('excel') || /\.(xlsx?|ods)$/i.test(filename)
        const isWord  = WORD_MIME.includes(ct)  || ct.includes('msword') || ct.includes('wordprocessingml') || /\.(docx?)$/i.test(filename)

        const isPdf = ct.includes('pdf') || /\.pdf$/i.test(filename)
        if (isPdf) {
          // PDF は解析しない。URLは本文から resumeUrl として保存済み
        } else if (ct.includes('text') || ct.includes('csv')) {
          textContents.push({ label: `Driveファイル(${filename})`, content: await res.text() })
        } else if (isExcel) {
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          const text = await extractExcelText(b64)
          if (text.trim()) {
            textContents.push({ label: `Drive Excel(${filename})`, content: text })
          } else {
            console.warn(`[DriveLink] Drive Excel テキスト抽出結果が空: ${id}`)
          }
        } else if (isWord) {
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          const rawText = await extractWordText(b64)
          if (rawText.trim()) {
            const text = cleanseWordText(rawText)
            textContents.push({ label: `Drive Word(${filename})`, content: text })
          } else {
            console.warn(`[DriveLink] Drive Word テキスト抽出結果が空: ${id}`)
          }
        } else {
          console.warn(`[DriveLink] Drive 未対応タイプ(${ct}) ファイル名(${filename}): ${id}`)
        }
      } else {
        console.warn(`[DriveLink] Drive取得失敗(${res.status}): ${id}`)
      }
    } catch (e) { console.warn(`[DriveLink] Drive fetch error: ${id}`, e) }
  }

  return { textContents, pdfAttachments }
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
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\r\n/g, '\n')
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
    console.log(`[Storage Upload] アップロード成功: ${filename} → ${publicUrl}`)
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
    } else {
      console.log('[BoxSheet] スプレッドシート書き込み成功:', boxUrls)
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
function splitMultiCandidateBody(body: string): string[] | null {
  const DELIM_RE = /^[\*\-=＊]{8,}\s*$/
  const lines = body.split(/\r?\n/)

  const delimIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (DELIM_RE.test(lines[i])) delimIndices.push(i)
  }

  // 区切り線が2本未満 → 複数人材なし
  if (delimIndices.length < 2) return null

  // 区切り線で parts に分割
  // parts[0] = 前置き（1人目の名前行を末尾に含む可能性）
  // parts[1] = 1人目の内容
  // parts[2] = 空行＋2人目の名前行
  // parts[3] = 2人目の内容 … と交互に続く
  const delimSet = new Set(delimIndices)
  const allParts: string[] = []
  let current: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (delimSet.has(i)) {
      allParts.push(current.join('\n'))
      current = []
    } else {
      current.push(lines[i])
    }
  }
  if (current.length > 0) allParts.push(current.join('\n'))

  const blocks: string[] = []
  for (let i = 1; i < allParts.length; i += 2) {
    const content = allParts[i].trim()
    if (!content) continue
    // 直前の偶数パートの末尾非空行 = 名前行
    const prevPart = allParts[i - 1] ?? ''
    const prevLines = prevPart.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const nameLine = prevLines[prevLines.length - 1] ?? ''
    const block = nameLine ? `${nameLine}\n${content}` : content
    if (block.length >= 50) blocks.push(block)
  }

  // 構造化フィールドを含むブロックのみ採用
  // 【氏名】形式 または ◇名前： / ◆スキルセット 等の ◇◆ ラベル形式 の両方を検出
  const CANDIDATE_FIELD_RE = /【[^】]{1,10}】|[◇◆][^\n：:]{1,15}[：:]/
  const validBlocks = blocks.filter(b => CANDIDATE_FIELD_RE.test(b))

  return validBlocks.length >= 2 ? validBlocks : null
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
    tracePhase = 'parse_raw'
    pipe(traceRid, tracePhase, { method: req.method })

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
    console.log('[inbound] data_env=', inboundDataEnv, 'pickedMode=', pickedMode ?? '', 'raw.mode=', raw.mode ?? '', 'rid=', traceRid)

    const type: string = normalizeInboundType(raw.type)
    /** 手動登録など、app_config フラグをバイパスして強制処理する場合は true */
    const forceProcess: boolean = raw.force === true || raw.force === 'true'
    const from: string = parseFrom(raw.from ?? '')
    const subject: string = raw.subject ?? ''
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
    let body: string = rawBody.includes('<html') || rawBody.includes('<div') || rawBody.includes('<p ')
      || rawBody.includes('<p>') || rawBody.includes('<table') || rawBody.includes('<span') || rawBody.includes('<td')
      ? stripHtml(rawBody)
      : rawBody
    // stripHtml が過剰に空になるケース（構造だけの HTML 等）は解析不能になるため raw にフォールバック
    if (!body.trim() && rawBody.trim()) {
      console.warn('[body] stripHtml で空のため rawBody にフォールバック', {
        picked_plain_len: pickedPlain.length,
        rawBody_len: rawBody.length,
      })
      body = rawBody.trim()
    }

    // 転送・返信メールの引用ヘッダを除去（「取得 Outlook for Mac 差出人:...」等が先頭に追加される）
    // 引用区切り行以降を除去して本文だけを残す
    const QUOTE_DELIMITERS = [
      /^[-_]{3,}[\s\S]*?差出人[:：]/m,
      /^_{3,}\s*$/m,
      /^From:\s+/m,
      /^送信元：/m,
    ]
    for (const delim of QUOTE_DELIMITERS) {
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
    } else if (raw.attachments?.trim()) {
      attachments = attachmentsFromJsonArrayString(raw.attachments)
    }

    const t0 = Date.now()
    const elapsed = () => `${Date.now() - t0}ms`

    tracePhase = 'step1_body_normalized'
    const supportedAttachments = attachments.filter(a => SUPPORTED_MIME.includes(a.mimeType))

    // Word/Excelのテキスト抽出（MIMEタイプ + 拡張子の両方で判定）
    const officeTextContents: { label: string; content: string }[] = []
    for (const att of attachments) {
      const attNameLower = (att.name ?? '').toLowerCase()
      const isWordByMime = WORD_MIME.includes(att.mimeType)
      const isExcelByMime = EXCEL_MIME.includes(att.mimeType)
      const isWordByExt = /\.(docx?|doc)$/.test(attNameLower) && !isExcelByMime
      const isExcelByExt = /\.(xlsx?|xls|ods|csv)$/.test(attNameLower) && !isWordByMime
      if (isWordByMime || isWordByExt) {
        const rawText = await extractWordText(att.data)
        if (rawText.trim()) {
          const text = cleanseWordText(rawText)
          officeTextContents.push({ label: `Word文書(${att.name ?? 'document'})`, content: text })
        } else console.warn(`[Word] 抽出結果が空: ${att.name} mimeType=${att.mimeType}`)
      } else if (isExcelByMime || isExcelByExt) {
        const text = await extractExcelText(att.data)
        if (text.trim()) officeTextContents.push({ label: `Excelファイル(${att.name ?? 'spreadsheet'})`, content: text })
        else console.warn(`[Excel] 抽出結果が空: ${att.name} mimeType=${att.mimeType}`)
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
    if (type === 'candidate' && !forceProcess) {
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
        '要員様のご提案をお願いいたします',
        '厚意顧客の注力案件のご紹介',
        'チョータツ',
      ]
      // 営業・広告・メルマガメールのスキップ（研修販売・サービス紹介等）
      const COMMERCIAL_SOLICITATION_KEYWORDS = [
        'メール配信解除',
        '配信停止はこちら',
        '配信解除はこちら',
        'メルマガ登録',
        '受信拒否はこちら',
        'このメールは配信専用',
        'こちらのメールは送信専用',
        '新人向けインフラ研修',
        '新人エンジニア育成',
        '助成金の活用も可能',
        '定員に達し次第受付を締め切',
      ]
      const isTraining = TRAINING_KEYWORDS.some(kw => body.includes(kw))
      const isSolicitation = PROJECT_SOLICITATION_KEYWORDS.some(kw => body.includes(kw))
      const isCommercial = COMMERCIAL_SOLICITATION_KEYWORDS.some(kw => body.includes(kw))
      if (isTraining || isSolicitation || isCommercial) {
        const skipReason = isTraining ? 'TRAINING_REPORT' : isSolicitation ? 'PROJECT_SOLICITATION' : 'COMMERCIAL_SOLICITATION'
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
    pipe(traceRid, tracePhase)
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
    pipe(traceRid, tracePhase)
    // Google Drive / Sheets / Docs リンクの取得
    const { textContents: driveTexts, pdfAttachments: drivePdfs } = await fetchGoogleLinks(body)
    const rawAllAttachments = [...supportedAttachments, ...drivePdfs]
    tracePhase = 'drive_links_done'
    console.log('[STEP4 DriveLink完了]', {
      rid: traceRid,
      texts: driveTexts.map(t => ({ label: t.label, length: t.content.length })),
      pdfs: drivePdfs.map(p => p.name),
      elapsed: elapsed(),
    })

    // PDF は解析しない。Storage へのアップロードのみ（後続処理では除外）
    const allAttachments = rawAllAttachments.filter(a => a.mimeType !== 'application/pdf')

    // Box URL の検出（人材登録時にスプレッドシートへ書き込み・DB保存するため事前に抽出）
    const boxUrls = type === 'candidate' || type === 'human' ? extractBoxUrls(body) : []
    if (boxUrls.length > 0) {
      console.log('[Box] Box URL検出:', boxUrls)
    }

    // 人材メールの添付ファイルを Google Drive にアップロード
    // （PDF/Word/Excel。アップロード失敗してもメイン処理は継続）
    let resumeUrl: string | null = null
    if (type === 'candidate' || type === 'human') {
      // メール本文中の Google URL を経歴書リンクとして抽出
      // 優先度: ①経歴書/スキルシート関連キーワード直後のURL > ②Sheetsリンク > ③Drive fileリンク
      const GOOGLE_URL_RE = /https:\/\/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/(?:spreadsheets|document)\/d\/)[^\s<>"'）\]]+/gi
      const allGoogleUrls = [...body.matchAll(GOOGLE_URL_RE)].map(m => ({ url: m[0], index: m.index! }))
      if (allGoogleUrls.length > 0) {
        const RESUME_KEYWORDS = ['スキルシート', '職務経歴書', '経歴書', 'レジュメ', 'resume', 'スキル']
        let picked: string | null = null
        // キーワード直後200文字以内のURLを優先
        for (const kw of RESUME_KEYWORDS) {
          const kwIdx = body.toLowerCase().indexOf(kw.toLowerCase())
          if (kwIdx === -1) continue
          const nearby = allGoogleUrls.find(u => u.index >= kwIdx && u.index <= kwIdx + 200)
          if (nearby) { picked = nearby.url; break }
        }
        // キーワードがなければSheetsを優先（スキルシートの可能性が高い）
        if (!picked) {
          picked = allGoogleUrls.find(u => u.url.includes('spreadsheets'))?.url ?? allGoogleUrls[0].url
        }
        resumeUrl = picked
      }

      // 添付ファイルを Supabase Storage にアップロード（PDF含む全添付）
      // アップロードのみ。PDF は AI 解析しない。
      for (const att of attachments) {
        if (!att.data) continue
        const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        const filename = att.name ? `${ts}_${att.name}` : `${ts}_resume.${att.mimeType.split('/')[1] ?? 'bin'}`
        const url = await uploadToStorage(filename, att.mimeType, att.data)
        if (url && !resumeUrl) resumeUrl = url
      }
    }

    // Drive取得テキスト + Officeテキストを統合（スキルマスター照合に使用）
    const allTextContents = [...driveTexts, ...officeTextContents]

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
    // 添付は上位20件に絞る（スキルシート一覧等の過剰ヒットを防ぐ）
    const attachDeduped = attachRated.filter(s => !bodyMatchedNames.has(s.name)).slice(0, 20)
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
    if (certNames.length > 0) console.log(`[skill_master] 資格タグ: ${certNames.join(', ')}`)

    // ── 人材メール ────────────────────────────────────────────
    if (type === 'candidate' || type === 'human') {
      // body が空の場合はsubjectを本文代わりに使う（cy-tech等の件名のみメール対策）
      const effectiveBody = body.trim() ? body : subject

      // ── 複数人材検出（*****や-----の区切り線） ─────────────────────────────
      const multiBlocks = splitMultiCandidateBody(effectiveBody)
      if (multiBlocks && multiBlocks.length >= 2) {
        console.log(`[multi-candidate] ${multiBlocks.length}人検出 from=${from} subject=${subject.slice(0, 80)}`)
        tracePhase = 'multi_candidate'

        const attachmentNames = [
          ...allAttachments.map(a => a.name ?? ''),
          ...officeTextContents.map(t => t.label),
        ].filter(Boolean).join('\n')

        type BlockResult = { id: string; name: string; skills: number }
        const results: BlockResult[] = []
        const allBlockBoxUrls: string[] = []

        for (const block of multiBlocks) {
          try {
            // ブロック固有のスキル照合
            const blockBodyText = [subject, block].join('\n')
            const { matched: blockBodyMatched } = extractAndRemoveSkills(blockBodyText, masterSkills, { looseCert: false })
            const blockBodyMatchedNames = new Set(blockBodyMatched.map(s => s.name))
            const blockAttachDeduped = attachRated.filter(s => !blockBodyMatchedNames.has(s.name)).slice(0, 10)
            const blockDbMatchedSkills = [...blockBodyMatched, ...blockAttachDeduped]
            const blockSkillNames = blockDbMatchedSkills.map(s => s.name)

            // フィールド抽出（件名＋ブロック本文＋添付名）
            const blockRegexBodyText = decodeHtmlEntities([subject, block, attachmentNames].join('\n'))
            const blockRegexFields = extractCandidateFieldsRegex(blockRegexBodyText, attachText)
            const blockProseFields = extractFromProse(blockRegexBodyText, attachText)

            const blockResolvedName = blockRegexFields.name
              ?? extractNameFallback([blockRegexBodyText, attachText].join('\n'))
              ?? extractCandidateCode(subject)
              ?? '不明'
            const blockRemoteAvailable = blockProseFields.workStyle === 'フルリモート'
              || blockProseFields.workStyle === 'リモート可'
              || blockProseFields.workStyle === 'リモート希望'
            const blockBoxUrls = extractBoxUrls(block)
            if (blockBoxUrls.length > 0) allBlockBoxUrls.push(...blockBoxUrls)

            const blockPayload = {
              data_env: inboundDataEnv,
              name: blockResolvedName,
              email: null as string | null,
              phone: null as string | null,
              skills: blockSkillNames,
              experience_years: toExperienceYears(blockRegexFields.experienceYears),
              raw_profile: {
                text: effectiveBody.slice(0, 10000),
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
                from, subject,
                emailReceivedAt,
                attachmentCount: allAttachments.length,
                attachmentNames: [
                  ...allAttachments.map(a => a.name ?? a.mimeType),
                  ...officeTextContents.map(t => t.label),
                ],
                driveLinks: driveTexts.map(t => t.label),
                aiAnalysis: { availableFrom: blockRegexFields.availableFrom },
                desiredProject: blockRegexFields.desiredProject,
                multiCandidateBlock: true,
              },
              duplicate_flag: false,
              created_by: 'make-inbound',
              box_url: blockBoxUrls[0] ?? null,
              box_status: blockBoxUrls.length > 0 ? 'pending' : null,
              resume_url: resumeUrl,
              desired_rate: blockRegexFields.desiredRate ?? null,
              from_company: sanitizeFromCompany(blockRegexFields.fromCompany),
            }

            const { data: blockData, error: blockError } = await supabase
              .from('candidates').insert(blockPayload).select().single()
            if (blockError) {
              console.error(`[multi-candidate] 保存エラー "${blockResolvedName}":`, blockError.message)
              continue
            }

            // 重複判定
            if (blockResolvedName !== '不明') {
              const { data: similar } = await supabase
                .from('candidates').select('id, name, skills, raw_profile')
                .eq('data_env', inboundDataEnv)
                .eq('name', blockResolvedName)
                .neq('id', blockData.id)
                .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
                .limit(5)
              if (similar && similar.length > 0) {
                for (const s of similar) {
                  const myStation = blockRegexFields.nearestStation ?? null
                  const theirStation = (s.raw_profile as any)?.nearestStation ?? null
                  if (myStation && theirStation && myStation !== theirStation) continue
                  const mySet = new Set(blockSkillNames.map(sk => sk.toLowerCase()))
                  const theirSet = new Set(((s.skills as string[]) || []).map(sk => sk.toLowerCase()))
                  const intersection = [...mySet].filter(sk => theirSet.has(sk)).length
                  const union = new Set([...mySet, ...theirSet]).size
                  if (union > 0 && intersection / union >= 0.4) {
                    await supabase.from('candidates').update({ duplicate_flag: true })
                      .eq('id', blockData.id).eq('data_env', inboundDataEnv)
                    console.log(`[multi-candidate duplicate] ${blockResolvedName} jaccard=${(intersection / union).toFixed(2)}`)
                    break
                  }
                }
              }
            }

            // candidate_skills INSERT
            const blockSkillsPayload = blockDbMatchedSkills
              .filter(s => s.name?.trim())
              .map(s => ({ candidate_id: blockData.id, category: s.category, skill: s.name.trim() }))
            if (blockSkillsPayload.length > 0) {
              await supabase.from('candidate_skills').delete().eq('candidate_id', blockData.id)
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
              linked_id: blockData.id,
              raw_body: block.slice(0, 3000),
            })

            results.push({ id: blockData.id, name: blockData.name, skills: blockSkillNames.length })
            console.log(`[multi-candidate] 登録完了: ${blockData.name} skills=${blockSkillNames.length}`)
          } catch (blockErr) {
            console.error(`[multi-candidate] ブロック処理エラー:`, String(blockErr))
          }
        }

        if (allBlockBoxUrls.length > 0) await appendToBoxSpreadsheet(allBlockBoxUrls)
        await markEmailProcessed(supabase, dedupConfigKey)
        return new Response(
          JSON.stringify({ ok: true, type: 'multi-candidate', count: results.length, results }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      // ── 単一人材（通常モード）────────────────────────────────────────────

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
      const skills = dbSkillNames

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
      const resolvedName = (analyzed.name && analyzed.name !== '不明')
        ? analyzed.name
        : (regexFields.name
            ?? extractNameFallback([regexBodyText, attachText].join('\n'))
            ?? extractCandidateCode(subject)
            ?? '不明')

      // AI空項目にregexフォールバックを適用
      const resolvedStation = analyzed.nearestStation || regexFields.nearestStation
      const resolvedPrefecture = analyzed.prefecture || regexFields.prefecture
      const resolvedExperienceYears = analyzed.experienceYears ?? regexFields.experienceYears
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
          text: effectiveBody.slice(0, 5000),
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
          from, subject,
          emailReceivedAt,
          attachmentCount: allAttachments.length,
          attachmentNames: [
            ...allAttachments.map(a => a.name ?? a.mimeType),
            ...officeTextContents.map(t => t.label),
          ],
          driveLinks: driveTexts.map(t => t.label),
          aiAnalysis: {
            ...analyzed,
            availableFrom: resolvedAvailableFrom,
          },
          desiredProject: regexFields.desiredProject,
          age: regexFields.age,
          gender: regexFields.gender,
          nationality: regexFields.nationality,
          selfPR: extractSelfPR(body, attachText) ?? null,
          agentComment: extractAgentComment(body, attachText) ?? null,
          geminiParseFallback: parseFallback,
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
        box_url: boxUrls[0] ?? null,
        box_status: boxUrls.length > 0 ? 'pending' : null,
        resume_url: resumeUrl,
        desired_rate: resolvedDesiredRate ?? null,
        from_company: sanitizeFromCompany(analyzed.fromCompany ?? regexFields.fromCompany),
      }

      const { data, error } = await supabase.from('candidates').insert(dbPayload).select().single()

      if (error) throw new Error(`候補者保存エラー: ${error.message}`)

      // ライブラリ重複判定（AI不使用・名前+スキルJaccard類似度）
      if (resolvedName && resolvedName !== '不明') {
        const { data: similar } = await supabase
          .from('candidates')
          .select('id, name, skills, raw_profile')
          .eq('data_env', inboundDataEnv)
          .eq('name', resolvedName)
          .neq('id', data.id)
          .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
          .limit(5)
        if (similar && similar.length > 0) {
          for (const s of similar) {
            // 駅が両方存在して異なる場合は別人と判断
            const myStation = resolvedStation ?? null
            const theirStation = (s.raw_profile as any)?.nearestStation ?? null
            if (myStation && theirStation && myStation !== theirStation) {
              console.log(`[duplicate] 駅が異なるため別人: ${resolvedName} my=${myStation} their=${theirStation}`)
              continue
            }
            const mySkillSet = new Set(skills.map((sk: string) => sk.toLowerCase()))
            const theirSkills = new Set(((s.skills as string[]) || []).map((sk: string) => sk.toLowerCase()))
            const intersection = [...mySkillSet].filter(sk => theirSkills.has(sk)).length
            const union = new Set([...mySkillSet, ...theirSkills]).size
            if (union > 0 && intersection / union >= 0.4) {
              await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', data.id).eq('data_env', inboundDataEnv)
              console.log(`[duplicate] 名前+スキル類似 → duplicate_flag=true: ${resolvedName} jaccard=${(intersection / union).toFixed(2)}`)
              break
            }
          }
        }
      }

      // candidate_skills に一括INSERT（DB照合結果のカテゴリを使用）
      const skillsPayload: { candidate_id: string; category: string; skill: string }[] = []
      for (const matched of dbMatchedSkills) {
        if (matched.name && matched.name.trim()) {
          skillsPayload.push({ candidate_id: data.id, category: matched.category, skill: matched.name.trim() })
        }
      }
      if (skillsPayload.length > 0) {
        await supabase.from('candidate_skills').delete().eq('candidate_id', data.id)
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
        linked_id: data.id,
        raw_body: body.slice(0, 3000),
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      // Box URLがあればスプレッドシートに書き込む（失敗してもメイン処理は継続）
      if (boxUrls.length > 0) {
        await appendToBoxSpreadsheet(boxUrls)
      }

      console.log(`[inbound] 人材登録完了: ${data.name}`)
      await markEmailProcessed(supabase, dedupConfigKey)
      return new Response(
        JSON.stringify({
          ok: true,
          type: 'candidate',
          id: data.id,
          name: data.name,
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
        console.log('[inbound] 案件メール解析は無効のためスキップ', { rid: traceRid, subject })
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
        if (pref) workLocation = `${pref} ${workLocationRaw}`
        else console.log('[station_unmapped]', workLocationRaw)
      }

      // リモート（条件分岐のためキーワード判定を維持）
      let remotePolicy: string | null = null
      const remotePolicyRaw = extractFieldTwoPhase(
        ['リモート', 'テレワーク', 'リモートワーク', '在宅', '出社'],
        allProjectText, attachText, null, 30,
      )
      if (remotePolicyRaw) remotePolicy = remotePolicyRaw
      else if (/フルリモート|完全リモート|100[%％]リモート/.test(allProjectText)) remotePolicy = 'フルリモート'
      else if (/リモート可|テレワーク可|在宅可/.test(allProjectText)) remotePolicy = 'リモート可'
      else if (/週[1-5１-５]日.*(?:リモート|在宅)|(?:リモート|在宅).*週[1-5１-５]日/.test(allProjectText)) remotePolicy = allProjectText.match(/週[1-5１-５]日.*(?:リモート|在宅)|(?:リモート|在宅).*週[1-5１-５]日/)?.[0] ?? 'リモート一部可'
      else if (/常駐|フル出社|出社必須/.test(allProjectText)) remotePolicy = '常駐'

      // 契約形態
      const contractRaw = extractFieldTwoPhase(
        ['契約形態', '契約', '就業形態', '雇用形態', '契約種別'],
        allProjectText, attachText, null, 30,
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
        ['単価', '単　価', '報酬', '月額', '予算', '報酬単価'],
        allProjectText, attachText, null, 50,
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
        allProjectText, attachText, null, 50,
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
      if (skillSectionM2) {
        const skillText = skillSectionM2.text
        const niceIdx = skillText.search(/[＜<]尚可[＞>]|尚可[：:]/)
        const requiredText = niceIdx >= 0 ? skillText.slice(0, niceIdx) : skillText
        const niceText = niceIdx >= 0 ? skillText.slice(niceIdx) : ''
        const skillFiltered = dbSkillNames.filter(s => !PROJECT_PROCESS_NOISE.has(s))
        // スペースなし比較も追加（"Spring Boot" vs "Springboot" 等の表記ゆれ対応）
        const matchesText = (s: string, text: string) => {
          const sl = s.toLowerCase()
          const tl = text.toLowerCase()
          return tl.includes(sl) || tl.includes(sl.replace(/\s+/g, ''))
        }
        const inRequired = skillFiltered.filter(s => matchesText(s, requiredText))
        projectRequiredSkills = inRequired.length > 0 ? inRequired : skillFiltered
        if (niceText) {
          projectNiceToHaveSkills = skillFiltered
            .filter(s => matchesText(s, niceText))
            .filter(s => !projectRequiredSkills.includes(s))
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

      const result = {
        title: cleanTitle,
        client,
        description: projectDescription,
        requiredSkills: projectRequiredSkills,
        niceToHaveSkills: projectNiceToHaveSkills,
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
        text: body.slice(0, 5000),
        from,
        subject,
        emailReceivedAt,
        attachmentCount: allAttachments.length,
        attachmentNames: [
          ...allAttachments.map((a) => a.name ?? a.mimeType),
          ...officeTextContents.map((t) => t.label),
        ],
        driveLinks: driveTexts.map((t) => t.label),
        batchSize: projectObjects.length,
      }

      const insertRows = projectObjects.map((raw, batchIndex) => {
        const requiredSkills = dedupeTrimmedSkills(raw.requiredSkills)
        const niceToHaveSkills = dedupeTrimmedSkills(raw.niceToHaveSkills)
        const description = typeof raw.description === 'string' ? raw.description : ''
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
            aiAnalysis: {
              ...raw,
              requiredSkills,
              niceToHaveSkills,
            },
          },
          created_by: 'make-inbound',
        }
      })

      const { data: insertedRows, error } = await supabase.from('projects').insert(insertRows).select()

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
            raw_body: body.slice(0, 3000),
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