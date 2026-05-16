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
//   GEMINI_INBOUND_TIMEOUT_MS: candidate/project の Gemini 1回あたり ms（Secrets。15〜300000。未設定時 38000）
//   ※ 全体の壁時計は Edge の上限もあり（関連度・Drive取得・Gemini の合計。プランにより概ね150〜400秒程度）
//   INBOUND_MAKE_SOFT_FAIL=true: 例外時も HTTP 200 + ok:false（Make がエラーでシナリオ停止しにくくする）
//   INBOUND_BODY_FALLBACK_ON_GEMINI_TIMEOUT=false: 人材で添付Geminiタイムアウト時の本文のみ再試行を無効化（既定は true）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.24.1'
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
  return parseInt(m[1], 10)
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

const AI_MODEL = 'gemini-2.5-flash-lite'      // 人材/案件解析
const AI_MODEL_FAST = 'gemini-2.5-flash-lite' // 関連度チェック（単純分類・低コスト）

/** candidate/project の Gemini 1 回あたり待ち上限（ms）。Secrets GEMINI_INBOUND_TIMEOUT_MS（15〜300000） */
function resolveInboundGeminiTimeoutMs(kind: 'candidate' | 'project' | 'match', override?: number): number {
  if (override != null) return override
  if (kind === 'match') return 25_000
  const raw = (Deno.env.get('GEMINI_INBOUND_TIMEOUT_MS') ?? '').trim()
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10)
    // Make.com HTTP の Timeout 最大 300 秒に合わせる（以前の 120 秒 cap はここ由来だっただけ）
    return Math.min(300_000, Math.max(15_000, n))
  }
  // Make.com HTTP 既定 40s 超えにくいようやや短め（長い解析は Make 側タイムアウト延長も推奨）
  return 38_000
}

function isInboundRelevanceCheckEnabled(): boolean {
  return (Deno.env.get('INBOUND_RELEVANCE_CHECK') ?? 'true').toLowerCase() !== 'false'
}

/** true のとき FATAL でも HTTP 200（JSON は ok:false）。Make のシナリオ全体停止を避ける */
function isInboundMakeSoftFail(): boolean {
  return (Deno.env.get('INBOUND_MAKE_SOFT_FAIL') ?? '').toLowerCase() === 'true'
}

/** 人材: 添付付き Gemini がタイムアウトしたら添付なしで再試行（既定 true） */
function isCandidateBodyFallbackOnTimeoutEnabled(): boolean {
  return (Deno.env.get('INBOUND_BODY_FALLBACK_ON_GEMINI_TIMEOUT') ?? 'true').toLowerCase() !== 'false'
}

/** 1 リクエストを追跡（Supabase ログで rid で検索） */
function pipe(rid: string, phase: string, detail?: Record<string, unknown>) {
  console.log(`[PIPE] rid=${rid} phase=${phase}`, detail ?? {})
}

/**
 * 無関係メールを本解析の前に弾く（Gemini 1 回・短文）。
 * 例外・タイムアウト・パース失敗時は true（取り込み続行）に倒す。
 */
async function classifyInboundRelevance(input: {
  subject: string
  from: string
  body: string
  inboundType: string
  attachmentCount: number
  attachmentMimeTypes: string[]
  traceRid?: string
}): Promise<{ relevant: boolean; durationMs: number; usedModel: string }> {
  const prompt = `
あなたはメール仕分け担当です。次のメールが「この HR / 案件マッチングシステムへの取り込み対象」かだけ判定してください。

取り込み対象（relevant: true）の例:
- 人材: 履歴・経歴・スキル・応募・職務経歴書・プロフィールなど
- 案件: 業務委託・派遣・開発募集・単価・必須スキル・期間・募集要件など
- 本文が短く、Google Drive / Sheets / Docs の共有リンクのみでも、取り込み前提で true（リンク先に資料がある想定）

取り込み不要（relevant: false）の例:
- 社内雑談、会議招集のみ、ニュースレター、一方向広告、システム自動通知・エラー通知、挨拶のみ、明らかに無関係な連絡

参考: Make から渡された type は「${input.inboundType}」。内容と矛盾する場合は本文を優先。
添付: ${input.attachmentCount} 件。MIME: ${input.attachmentMimeTypes.length ? input.attachmentMimeTypes.join(', ') : 'なし'}

件名: ${input.subject}
差出人: ${input.from}

本文（冒頭・最大8000文字）:
${input.body.slice(0, 8000)}

JSON のみ返す（説明・コードブロック禁止）:
{"relevant": true または false}
`.trim()

  const rid = input.traceRid ?? '—'
  const TIMEOUT_MS = 15_000

  // ---- Bedrock Claude 3 Haiku 門番フィルター（Lambda 経由・最速・最安） ----
  // LAMBDA_GATE_FILTER_URL が設定されている場合のみ実行。
  // "0" → 即スキップ、"1" → 即通過、それ以外 or エラー → 後続モデルにフォールバック。
  const gateLambdaUrl = Deno.env.get('LAMBDA_GATE_FILTER_URL')
  if (gateLambdaUrl) {
    const gateStart = Date.now()
    try {
      const preview = `件名: ${input.subject}\n差出人: ${input.from}\n\n${input.body.slice(0, 500)}`
      const lambdaApiKey = Deno.env.get('LAMBDA_API_KEY') ?? ''
      const gateRes = await Promise.race([
        fetch(gateLambdaUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(lambdaApiKey ? { 'x-api-key': lambdaApiKey } : {}),
          },
          body: JSON.stringify({ text: preview }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('gate-filter Lambda タイムアウト (5s)')),
            5_000,
          ),
        ),
      ])
      if (gateRes.ok) {
        const gateJson = await gateRes.json() as { result?: string }
        const digit = (gateJson.result ?? '').trim().slice(0, 1)
        pipe(rid, 'gate_filter_done', { digit, durationMs: Date.now() - gateStart })
        if (digit === '0') return { relevant: false, durationMs: Date.now() - gateStart, usedModel: 'bedrock-claude-3-haiku (gate-filter)' }
        if (digit === '1') return { relevant: true, durationMs: Date.now() - gateStart, usedModel: 'bedrock-claude-3-haiku (gate-filter)' }
        // 0/1 以外（異常応答）は後続フォールバックへ
        console.warn(`[RELEVANCE] gate-filter 異常応答 digit="${digit}"、次のモデルへ`)
      } else {
        console.warn(`[RELEVANCE] gate-filter HTTP ${gateRes.status}、次のモデルへフォールバック`)
      }
    } catch (e) {
      console.warn(`[RELEVANCE] gate-filter Lambda 失敗、次のモデルへフォールバック: ${String(e)}`)
    }
  }

  // ---- Cerebras を試みる ----
  const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY')
  if (cerebrasKey) {
    pipe(rid, 'relevance_cerebras_wait', { inboundType: input.inboundType })
    try {
      const r = await generateJSONWithCerebras(prompt, TIMEOUT_MS, `rid=${rid} phase=relevance_check`)
      const obj = r.result as { relevant?: unknown }
      const relevant = typeof obj.relevant === 'boolean' ? obj.relevant : true
      return { relevant, durationMs: r.durationMs, usedModel: CEREBRAS_MODEL }
    } catch (e) {
      console.warn(`[RELEVANCE] Cerebras失敗、Groqにフォールバック: ${String(e)}`)
    }
  }

  // ---- Groq を試みる ----
  const groqKey = Deno.env.get('GROQ_API_KEY')
  if (groqKey) {
    pipe(rid, 'relevance_groq_wait', { inboundType: input.inboundType })
    try {
      const r = await generateJSONWithGroq(prompt, TIMEOUT_MS, `rid=${rid} phase=relevance_check`)
      const obj = r.result as { relevant?: unknown }
      const relevant = typeof obj.relevant === 'boolean' ? obj.relevant : true
      return { relevant, durationMs: r.durationMs, usedModel: GROQ_MODEL }
    } catch (e) {
      console.warn(`[RELEVANCE] Groq失敗、Geminiにフォールバック: ${String(e)}`)
    }
  }

  // ---- Gemini フォールバック ----
  pipe(rid, 'relevance_gemini_wait', { inboundType: input.inboundType })
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL_FAST, generationConfig: { temperature: 0 } })
  const start = Date.now()
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`関連度判定タイムアウト (${TIMEOUT_MS}ms) rid=${rid} phase=relevance_gemini`)), TIMEOUT_MS)
  )
  const res = await Promise.race([model.generateContent(prompt), timeoutPromise])
  const durationMs = Date.now() - start
  const raw = res.response.text()
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  let parsed: { relevant?: unknown }
  try {
    parsed = JSON.parse(cleaned) as { relevant?: unknown }
  } catch {
    console.warn('[RELEVANCE] JSON パース失敗、続行扱い', cleaned.slice(0, 200))
    return { relevant: true, durationMs, usedModel: AI_MODEL_FAST }
  }
  const r = parsed.relevant
  const relevant = typeof r === 'boolean' ? r : true
  return { relevant, durationMs, usedModel: AI_MODEL_FAST }
}

async function generateJSON(
  prompt: string,
  attachments: Attachment[],
  kind: 'candidate' | 'project' | 'match' = 'project',
  /** 1回目が空/失敗のとき追加で試す回数を含む総試行回数（例: 2 なら最大2回） */
  maxRetries = 2,
  timeoutMs?: number,
  /** ログ用: どの Gemini 呼び出しか（タイムアウト時も識別） */
  geminiTrace?: { rid: string; phase: string },
  /** 使用するモデル名（省略時は AI_MODEL = gemini-2.5-flash） */
  geminiModel?: string,
): Promise<{ result: unknown; durationMs: number }> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: geminiModel ?? AI_MODEL, generationConfig: { temperature: 0 } })

  const parts: object[] = []
  for (const att of attachments) {
    if (att.data && SUPPORTED_MIME.includes(att.mimeType)) {
      parts.push({ inlineData: { data: att.data, mimeType: att.mimeType } })
    }
  }
  parts.push({ text: prompt })

  const GEMINI_TIMEOUT_MS = resolveInboundGeminiTimeoutMs(kind, timeoutMs)
  const gt = geminiTrace
  const logP = (msg: string, extra?: string) =>
    gt ? `[inbound ${gt.rid}] [${gt.phase}] ${msg}${extra ?? ''}` : `[generateJSON] ${msg}${extra ?? ''}`

  const start = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(logP(`gemini attempt ${attempt} 開始`, ` timeoutMs=${GEMINI_TIMEOUT_MS}`))
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() =>
          reject(new Error(
            `Gemini APIタイムアウト (${GEMINI_TIMEOUT_MS}ms) rid=${gt?.rid ?? '?'} phase=${gt?.phase ?? kind}`,
          )), GEMINI_TIMEOUT_MS)
      )
      const res = await Promise.race([model.generateContent(parts), timeoutPromise])
      const durationMs = Date.now() - start
      console.log(logP(`gemini attempt ${attempt} 完了 durationMs=${durationMs}`))
      const raw = res.response.text()
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const result = JSON.parse(cleaned)

      // 空結果の場合はリトライ（candidate / project のみ）。match はスキーマが違うため空判定しない。
      const isCandidateEmpty =
        kind === 'candidate' &&
        Array.isArray((result as any).skills) &&
        (result as any).skills.length === 0 &&
        !(result as any).summary

      const isProjectEmpty = kind === 'project' && isProjectAIResultEmpty(result)

      const isEmpty = isCandidateEmpty || isProjectEmpty
      if (isEmpty && attempt < maxRetries) {
        console.warn(logP(`attempt ${attempt}: 空結果のためリトライ`))
        continue
      }

      return { result, durationMs }
    } catch (e) {
      lastError = e
      console.warn(logP(`attempt ${attempt} 失敗 elapsed=${Date.now() - start}ms`), String(e))
      // API タイムアウトは 2 回目まで待つと Make 40s を大幅超過するためリトライしない
      if (String(e).includes('Gemini APIタイムアウト')) {
        throw e
      }
      if (attempt < maxRetries) {
        console.warn(logP(`attempt ${attempt}: リトライします`))
      }
    }
  }
  throw lastError
}

// ---- Cerebras API（テキスト専用・大容量無料枠） ----

const CEREBRAS_MODEL = 'llama3.1-8b' // 確認済み・データ抽出用

async function generateJSONWithCerebras(
  prompt: string,
  timeoutMs = 30_000,
  traceInfo?: string,
): Promise<{ result: unknown; durationMs: number }> {
  const apiKey = Deno.env.get('CEREBRAS_API_KEY')
  if (!apiKey) throw new Error('CEREBRAS_API_KEY 未設定')

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Cerebras APIエラー (${res.status}): ${err.slice(0, 200)}`)
    }

    const json = await res.json()
    const content = (json.choices?.[0]?.message?.content ?? '').trim()
    if (!content) throw new Error('Cerebras レスポンスが空')

    const m = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim().match(/[\[{][\s\S]*[\]}]/)
    if (!m) throw new Error(`Cerebras JSON抽出失敗: ${content.slice(0, 100)}`)
    const result = JSON.parse(m[0])
    const durationMs = Date.now() - start
    console.log(`[Cerebras] 成功 durationMs=${durationMs}${traceInfo ? ` ${traceInfo}` : ''}`)
    return { result, durationMs }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ---- Groq API（テキスト専用・無料枠 14,400回/日） ----

const GROQ_MODEL = 'llama-3.1-8b-instant' // TPD 500,000トークン（70b比5倍・1日125件処理可）

/**
 * Groq API でJSON抽出（テキストのみ・添付非対応）
 * OpenAI互換APIなので fetch + JSON modeで呼び出す
 */
async function generateJSONWithGroq(
  prompt: string,
  timeoutMs = 30_000,
  traceInfo?: string,
): Promise<{ result: unknown; durationMs: number }> {
  const apiKey = Deno.env.get('GROQ_API_KEY')
  if (!apiKey) throw new Error('GROQ_API_KEY 未設定')

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Groq APIエラー (${res.status}): ${err.slice(0, 200)}`)
    }

    const json = await res.json()
    const content = (json.choices?.[0]?.message?.content ?? '').trim()
    if (!content) throw new Error('Groq レスポンスが空')

    const result = JSON.parse(content)
    const durationMs = Date.now() - start
    console.log(`[Groq] 成功 durationMs=${durationMs}${traceInfo ? ` ${traceInfo}` : ''}`)
    return { result, durationMs }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

/**
 * Groq → Gemini の順で試みるJSON生成ラッパー
 * - 添付ファイル（画像・PDF）がある場合はGroq非対応のためGemini直行
 * - GROQ_API_KEY 未設定時もGemini直行
 */
type TextContent = { label: string; content: string }

/** Groqプロンプト用スマートトランケーション: 先頭65% + 末尾35% */
function smartTruncateForGroq(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.65)
  const tail = maxChars - head
  return text.slice(0, head) + '\n...(中略)...\n' + text.slice(-tail)
}

/**
 * Groq専用コンパクト候補者プロンプト
 * オーバーヘッド ~750文字 / データに ~3,550文字を確保 / PDFはスマートトランケーション
 */
function buildCandidateGroqPrompt(
  from: string,
  subject: string,
  body: string,
  textContents: TextContent[],
): string {
  const GROQ_MAX = 4_300
  const header = `人材紹介メール解析。書かれた情報のみ抽出。推測禁止。差出人(${from})は営業担当者。
氏名はPDF/本文から読む。「М・T」「A.B.」「T.Y.」などイニシャル形式も有効な氏名として採用すること。見つからない場合のみ"不明"。emailは候補者本人のみ(差出人は含めない)。experienceYearsは職歴の最初の年から現在（または最後の職歴終了年）までを計算すること。

以下JSONのみ返す:
{"name":string,"email":string|null,"phone":string|null,"skills":string[],"skillsByCategory":{"languages":[],"frameworks":[],"libraries":[],"os":[],"databases":[],"dwh":[],"clouds":[],"infrastructures":[],"tools":[],"methodologies":[],"certifications":[],"design":[],"marketing":[],"others":[]},"roles":string[],"industries":string[],"experienceYears":number|null,"summary":string,"nearestStation":string|null,"prefecture":string|null,"availableRegions":string[]|null,"currentWorkLocation":string|null,"remoteAvailable":boolean,"desiredRate":string|null,"fromCompany":string|null}

件名:${subject}
本文:`
  const footer = '\nJSON:'
  const dataBudget = GROQ_MAX - header.length - footer.length

  // ボディ予算: textContentsがある場合は25%、ない場合は全体（添付なし本文のみメールを最大活用）
  const bodyRatio = textContents.length > 0 ? 0.25 : 1.0
  const bodyBudget = Math.min(body.length, Math.floor(dataBudget * bodyRatio))
  let dataSection = body.slice(0, bodyBudget)

  // テキストコンテンツ（PDF/Drive/Office）: 残り予算でスマートトランケーション
  for (const t of textContents) {
    const labelOverhead = t.label.length + 15 // "--- label ---\n"
    const remaining = dataBudget - dataSection.length - labelOverhead
    if (remaining <= 100) break
    const content = smartTruncateForGroq(t.content, remaining)
    dataSection += `\n--- ${t.label} ---\n${content}`
  }

  return `${header}\n${dataSection}${footer}`
}

/**
 * Groq専用コンパクト案件プロンプト
 */
function buildProjectGroqPrompt(
  subject: string,
  body: string,
  textContents: TextContent[],
): string {
  const GROQ_MAX = 4_300
  const header = `案件メール解析。書かれた情報のみ抽出。推測禁止。複数案件は配列で返す。

以下JSONのみ返す:
[{"title":string,"requiredSkills":string[],"budgetMin":number|null,"budgetMax":number|null,"startDate":string|null,"endDate":string|null,"workLocation":string|null,"remotePolicy":string|null,"contractType":string|null,"headcount":number|null,"workload":string|null,"settlementMin":number|null,"settlementMax":number|null,"roleSummary":string|null,"industry":string|null}]

件名:${subject}
本文:`
  const footer = '\nJSON:'
  const dataBudget = GROQ_MAX - header.length - footer.length

  const bodyRatio = textContents.length > 0 ? 0.4 : 1.0
  const bodyBudget = Math.min(body.length, Math.floor(dataBudget * bodyRatio))
  let dataSection = body.slice(0, bodyBudget)

  for (const t of textContents) {
    const labelOverhead = t.label.length + 15
    const remaining = dataBudget - dataSection.length - labelOverhead
    if (remaining <= 100) break
    const content = smartTruncateForGroq(t.content, remaining)
    dataSection += `\n--- ${t.label} ---\n${content}`
  }

  return `${header}\n${dataSection}${footer}`
}

async function generateJSONSmart(
  prompt: string,
  attachments: Attachment[],
  kind: 'candidate' | 'project' | 'match',
  maxRetries = 2,
  timeoutMs?: number,
  geminiTrace?: { rid: string; phase: string },
  geminiModel?: string,
  groqPrompt?: string, // Groq専用コンパクトプロンプト（指定時はこちらを使用）
): Promise<{ result: unknown; durationMs: number; usedModel: string }> {
  const hasImageAttachments = attachments.some(a =>
    SUPPORTED_MIME.includes(a.mimeType)
  )
  const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY')
  const groqKey = Deno.env.get('GROQ_API_KEY')

  // 画像添付あり・テキスト系キー未設定 → Gemini直行
  if (hasImageAttachments || (!cerebrasKey && !groqKey)) {
    const r = await generateJSON(prompt, attachments, kind, maxRetries, timeoutMs, geminiTrace, geminiModel)
    return { ...r, usedModel: geminiModel ?? AI_MODEL }
  }

  // Cerebras / Groq はどちらも128Kコンテキスト → フルプロンプトをそのまま渡す
  const trace = geminiTrace ? `rid=${geminiTrace.rid} phase=${geminiTrace.phase}` : undefined
  const timeout = timeoutMs ?? 30_000

  // Cerebras 8B は軽量タスク（match）のみ。候補者/案件の構造化抽出は苦手なのでGroqに直行
  if (cerebrasKey && kind === 'match') {
    try {
      const r = await generateJSONWithCerebras(prompt, timeout, trace)
      return { ...r, usedModel: CEREBRAS_MODEL }
    } catch (e) {
      console.warn(`[Cerebras] 失敗、Groq 70Bにフォールバック: ${String(e)}`)
    }
  }

  // Groq 70B（128K）
  if (groqKey) {
    try {
      const r = await generateJSONWithGroq(prompt, timeout, trace)
      return { ...r, usedModel: GROQ_MODEL }
    } catch (e) {
      console.warn(`[Groq] 失敗、Geminiにフォールバック: ${String(e)}`)
    }
  }

  // Gemini フォールバック
  try {
    const r = await generateJSON(prompt, attachments, kind, maxRetries, timeoutMs, geminiTrace, geminiModel)
    return { ...r, usedModel: geminiModel ?? AI_MODEL }
  } catch (e) {
    console.warn(`[Gemini] 失敗、Bedrock Haikuにフォールバック: ${String(e)}`)
  }

  // Bedrock Claude Haiku 最終フォールバック
  const bedrockParseUrl = Deno.env.get('LAMBDA_BEDROCK_PARSE_URL')
  const bedrockApiKey = Deno.env.get('LAMBDA_API_KEY') ?? ''
  if (bedrockParseUrl) {
    const bedrockStart = Date.now()
    try {
      const bedrockRes = await fetch(bedrockParseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bedrockApiKey ? { 'x-api-key': bedrockApiKey } : {}),
        },
        body: JSON.stringify({ prompt }),
      })
      if (bedrockRes.ok) {
        const bedrockJson = await bedrockRes.json() as { result?: string; error?: string }
        if (bedrockJson.result) {
          const cleaned = bedrockJson.result.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
          const match = cleaned.match(/[\[{][\s\S]*[\]}]/)
          if (match) {
            const result = JSON.parse(match[0])
            console.log(`[Bedrock] 成功 durationMs=${Date.now() - bedrockStart}`)
            return { result, durationMs: Date.now() - bedrockStart, usedModel: 'bedrock-claude-haiku-4-5' }
          }
        }
      }
      console.warn(`[Bedrock] parse失敗 status=${bedrockRes.status}`)
    } catch (e) {
      console.warn(`[Bedrock] フォールバック失敗: ${String(e)}`)
    }
  }

  throw new Error('全AIプロバイダーが失敗しました (Cerebras/Groq/Gemini/Bedrock)')
}

type MatchResult = { score: number; summary: string; duplicateSuspected: boolean }

// 初回リリースは手動運用しやすいように、環境変数で自動マッチを切替可能にする
// - AUTO_MATCH_ENABLED="true" で有効化（未設定/それ以外は無効）
const AUTO_MATCH_ENABLED = (Deno.env.get('AUTO_MATCH_ENABLED') ?? '').toLowerCase() === 'true'
// Make.com 側のタイムアウトに引っかかりやすいので、まずは控えめに
const AUTO_MATCH_MAX_CANDIDATES = 40

async function matchCandidateToProject(
  candidateProfile: Record<string, unknown>,
  projectRequirements: Record<string, unknown>,
  trace?: { rid: string },
): Promise<MatchResult> {
  const prompt = `
あなたはマッチング判定AIです。以下の「人材」と「案件」を読み、マッチング結果を JSON だけで返してください。
余分な説明文・コードブロックは禁止です。

人材:
${JSON.stringify(candidateProfile, null, 2)}

案件:
${JSON.stringify(projectRequirements, null, 2)}

返却 JSON フィールド:
- score: number（0〜100）
- summary: string（理由を200字以内）
- duplicateSuspected: boolean（人材が既存と非常に似ている場合true）

JSON:`.trim()

  const rid = trace?.rid ?? '—'
  pipe(rid, 'gemini_auto_match_pair')

  // match は軽量・高速優先（長いリトライはMakeのHTTPタイムアウトで無駄になりやすい）
  const { result } = await generateJSON(prompt, [], 'match', 1, 25_000, {
    rid,
    phase: 'gemini_auto_match',
  })
  const r = result as Partial<MatchResult>
  const score = typeof r.score === 'number' ? r.score : Number(r.score ?? 0)
  return {
    score: Number.isFinite(score) ? score : 0,
    summary: typeof r.summary === 'string' ? r.summary : String(r.summary ?? ''),
    duplicateSuspected: Boolean(r.duplicateSuspected),
  }
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
      console.log(`[Doc] バイナリ raw 抽出: ${result.length}文字`)
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
function cleanseExcelCsv(csv: string, maxChars = 6000): string {
  const lines = csv.split('\n')
  const cleaned: string[] = []
  let emptyLineCount = 0

  for (const line of lines) {
    // カンマ区切りでセルを分割し、空白・空セルを除去
    const cells = line.split(',').map(c => c.trim()).filter(c => c !== '' && c !== '""')

    if (cells.length === 0) {
      // 空行は連続2行まで許可（セクション区切りとして保持）
      if (emptyLineCount < 1) {
        cleaned.push('')
        emptyLineCount++
      }
      continue
    }

    emptyLineCount = 0

    // セルが1つしかない場合はそのまま出力（見出し行等）
    if (cells.length === 1) {
      cleaned.push(cells[0])
      continue
    }

    // 複数セルは「/」で区切って出力
    cleaned.push(cells.join(' / '))
  }

  // 末尾の空行を除去して結合
  const result = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // 最大文字数に切り詰め
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
    console.log(`[Excel] read開始 bytes=${bytes.byteLength}`)
    const workbook = XLSX.read(bytes, { type: 'array' })
    console.log(`[Excel] sheets=${workbook.SheetNames.join(',')}`)
    const texts: string[] = []
    for (const sheetName of workbook.SheetNames.slice(0, 3)) {
      const sheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(sheet)
      console.log(`[Excel] sheet="${sheetName}" csvLen=${csv.length}`)
      if (csv.trim()) {
        const cleansed = cleanseExcelCsv(csv)
        console.log(`[Excel] sheet="${sheetName}" rawLen=${csv.length} cleansedLen=${cleansed.length} ratio=${Math.round(cleansed.length / csv.length * 100)}%`)
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
        console.log(`[DriveLink] Sheets取得成功: ${id}`)
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
        console.log(`[DriveLink] Docs取得成功: ${id}`)
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
      console.log(`[DriveLink] スキップ（ポートフォリオ等）: ${id}`)
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
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          pdfAttachments.push({ data: b64, mimeType: 'application/pdf', name: filename })
          console.log(`[DriveLink] Drive PDF取得成功: ${id} (${filename})`)
        } else if (ct.includes('text') || ct.includes('csv')) {
          textContents.push({ label: `Driveファイル(${filename})`, content: await res.text() })
          console.log(`[DriveLink] Drive text取得成功: ${id} (${filename})`)
        } else if (isExcel) {
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          const text = await extractExcelText(b64)
          if (text.trim()) {
            textContents.push({ label: `Drive Excel(${filename})`, content: text })
            console.log(`[DriveLink] Drive Excel取得成功: ${id} (${filename}) ${text.length}文字`)
          } else {
            console.warn(`[DriveLink] Drive Excel テキスト抽出結果が空: ${id}`)
          }
        } else if (isWord) {
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          const text = await extractWordText(b64)
          if (text.trim()) {
            textContents.push({ label: `Drive Word(${filename})`, content: text })
            console.log(`[DriveLink] Drive Word取得成功: ${id} (${filename}) ${text.length}文字`)
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
 * pdfjs-dist（npm: 経由・日本語CMap対応）で PDF からテキストを抽出する
 * - npm: プレフィックスで canvas.node をロードしない
 * - CMap を CDN から取得して日本語フォントに対応
 * テキストPDF: 成功 / スキャンPDF・暗号化PDF: null を返す
 */
async function extractPdfTextWithPdfjs(dataB64: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('npm:pdfjs-dist@3.11.174/legacy/build/pdf.js') as any
    const pdfjsLib = mod.default ?? mod
    if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = ''
    const pdfBytes = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0))
    const doc = await pdfjsLib.getDocument({
      data: pdfBytes,
      // 日本語CMap（MS明朝・MSゴシック等）を CDN から取得
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise
    const pageTexts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pageTexts.push(content.items.map((item: any) => item.str ?? '').join(''))
    }
    const text = pageTexts.join('\n').trim()
    if (text.length > 50) return text
    console.warn(`[PDF Free Extract] テキスト不足(${text.length}文字) - スキャンPDFの可能性`)
    return null
  } catch (e) {
    console.warn(`[PDF Free Extract] 失敗: ${String(e)}`)
    return null
  }
}

/**
 * PDFバイナリをテキスト抽出する（2段階処理の第1ステップ）
 * 優先順位: pdfjs-dist（無料） → Gemini（スキャンPDFのみフォールバック）
 * 抽出成功したPDFはテキストに変換し、バイナリ添付から除外することで Groq 利用を可能にする
 */
async function extractPdfTextsWithGemini(
  pdfs: Attachment[],
  traceRid: string,
): Promise<{ extractedTexts: Array<{ label: string; content: string }>; remainingPdfs: Attachment[] }> {
  if (pdfs.length === 0) {
    return { extractedTexts: [], remainingPdfs: pdfs }
  }

  const extractedTexts: Array<{ label: string; content: string }> = []
  const remainingPdfs: Attachment[] = []

  for (const pdf of pdfs) {
    if (!pdf.data) { remainingPdfs.push(pdf); continue }

    // ① pdfjs-dist で無料テキスト抽出を試みる
    // base64長 2,000,000 ≒ 実ファイル ~1.5MB 超はメモリ超過リスクがあるためスキップ
    const PDFJS_MAX_B64 = 2_000_000
    if (pdf.data.length > PDFJS_MAX_B64) {
      console.warn(`[PDF Extract] pdfjs スキップ（サイズ超過 ${pdf.data.length}文字）: ${pdf.name} rid=${traceRid}`)
      remainingPdfs.push(pdf)
      continue
    }
    const freeText = await extractPdfTextWithPdfjs(pdf.data)
    // Lambda PDF Processor の URL（設定済みの場合のみ使用）
    const pdfLambdaUrl = Deno.env.get('LAMBDA_PDF_PROCESSOR_URL')
    const pdfLambdaKey = Deno.env.get('LAMBDA_API_KEY') ?? ''

    if (freeText) {
      // ②-A テキスト抽出成功 → Lambda PDF Processor（Bedrock Haiku 要約）があれば送信
      // Haiku が構造化要約を返すので、下流の Gemini に渡すトークン量を大幅削減できる。
      if (pdfLambdaUrl) {
        try {
          const pdfRes = await Promise.race([
            fetch(pdfLambdaUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(pdfLambdaKey ? { 'x-api-key': pdfLambdaKey } : {}),
              },
              body: JSON.stringify({ extractedText: freeText.slice(0, 8000) }),
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('pdf-processor Lambda タイムアウト (20s)')),
                20_000,
              ),
            ),
          ])
          if (pdfRes.ok) {
            const pdfJson = await pdfRes.json() as { summary?: string; rawText?: string }
            // summary（Haiku整形テキスト）を優先、なければ rawText、それも無ければ生テキスト
            const content = pdfJson.summary ?? pdfJson.rawText ?? freeText.slice(0, 6000)
            extractedTexts.push({ label: `PDF(${pdf.name ?? 'attachment'})`, content })
            console.log(`[PDF Extract] Lambda Haiku要約成功: ${pdf.name} ${content.length}文字 rid=${traceRid}`)
            continue
          }
          console.warn(`[PDF Extract] pdf-processor HTTP ${pdfRes.status}、生テキストで継続`)
        } catch (e) {
          console.warn(`[PDF Extract] pdf-processor Lambda 失敗、生テキストで継続: ${String(e)}`)
        }
      }
      // Lambda 未設定 or 失敗 → 従来通り生テキストを使用
      extractedTexts.push({ label: `PDF(${pdf.name ?? 'attachment'})`, content: freeText.slice(0, 6000) })
      console.log(`[PDF Extract] pdfjs成功（無料）: ${pdf.name} ${freeText.length}文字 rid=${traceRid}`)
      continue
    }

    // ②-B スキャンPDF → Lambda PDF Processor（Textract + Haiku）を優先し、次に Gemini へフォールバック
    if (pdfLambdaUrl) {
      try {
        const scanRes = await Promise.race([
          fetch(pdfLambdaUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(pdfLambdaKey ? { 'x-api-key': pdfLambdaKey } : {}),
            },
            body: JSON.stringify({ pdfBase64: pdf.data }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('pdf-processor scan タイムアウト (30s)')),
              30_000,
            ),
          ),
        ])
        if (scanRes.ok) {
          const scanJson = await scanRes.json() as { summary?: string; rawText?: string }
          const content = scanJson.summary ?? scanJson.rawText ?? ''
          if (content.length > 50) {
            extractedTexts.push({ label: `PDF(${pdf.name ?? 'attachment'})`, content })
            console.log(`[PDF Extract] Lambda Textract+Haiku成功（スキャンPDF）: ${pdf.name} ${content.length}文字 rid=${traceRid}`)
            continue
          }
          console.warn(`[PDF Extract] pdf-processor テキスト不足(${content.length}文字): ${pdf.name}`)
        } else {
          console.warn(`[PDF Extract] pdf-processor scan HTTP ${scanRes.status}: ${pdf.name}`)
        }
      } catch (e) {
        console.warn(`[PDF Extract] pdf-processor scan Lambda 失敗: ${pdf.name} ${String(e)} rid=${traceRid}`)
      }
    }

    // ③ Gemini にフォールバック（GROQ_API_KEY 設定時のみ。未設定時はバイナリのまま渡す）
    const groqKey = Deno.env.get('GROQ_API_KEY')
    if (!groqKey) {
      remainingPdfs.push(pdf)
      continue
    }
    try {
      const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
      const model = genAI.getGenerativeModel({ model: AI_MODEL_FAST })
      const parts = [
        { inlineData: { data: pdf.data, mimeType: pdf.mimeType } },
        { text: 'このファイルのテキストを全て抽出してください。整形・要約不要。テキストのみ出力。' },
      ]
      const res = await Promise.race([
        model.generateContent(parts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PDF抽出タイムアウト')), 20_000)
        ),
      ])
      const text = res.response.text().trim()
      if (text.length > 50) {
        extractedTexts.push({ label: `PDF(${pdf.name ?? 'attachment'})`, content: text.slice(0, 6000) })
        console.log(`[PDF Extract] Gemini成功（スキャンPDF）: ${pdf.name} ${text.length}文字 rid=${traceRid}`)
      } else {
        remainingPdfs.push(pdf)
        console.warn(`[PDF Extract] Geminiテキスト不足(${text.length}文字)、バイナリ処理へ: ${pdf.name} rid=${traceRid}`)
      }
    } catch (e) {
      remainingPdfs.push(pdf)
      console.warn(`[PDF Extract] Gemini失敗、バイナリ処理へ: ${pdf.name} ${String(e)} rid=${traceRid}`)
    }
  }

  console.log(`[PDF Extract] 完了: 変換=${extractedTexts.length}件 残バイナリ=${remainingPdfs.length}件 rid=${traceRid}`)
  return { extractedTexts, remainingPdfs }
}

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
async function checkAndMarkEmailDuplicate(
  supabase: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>,
  from: string,
  subject: string,
  body: string,
  dedupSalt = '',
): Promise<boolean> {
  try {
    const hash = await sha256Hex(`${from}|${subject}|${body.slice(0, 200)}|${dedupSalt}`)
    const configKey = `ehash_${hash.slice(0, 24)}`
    const { data } = await supabase.from('app_config').select('value').eq('key', configKey).maybeSingle()
    if (data?.value) {
      const storedAt = new Date(data.value).getTime()
      if (Date.now() - storedAt < 12 * 60 * 60 * 1000) {
        return true // 12時間以内に同一メールを処理済み
      }
    }
    // 未処理 → ハッシュを記録して続行
    await supabase.from('app_config').upsert(
      { key: configKey, value: new Date().toISOString() },
      { onConflict: 'key' },
    )
    return false
  } catch (e) {
    // ハッシュ判定失敗は処理続行（false にフォールバック）
    console.warn('[DEDUP] 重複判定失敗、続行:', String(e))
    return false
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  let traceRid = ''
  /** 最後に「ここまで進んだ」状態（FATAL 時に記録） */
  let tracePhase = 'none'

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
    const from: string = parseFrom(raw.from ?? '')
    const subject: string = raw.subject ?? ''
    const pickedPlain = pickEmailPlainBody(raw)
    let rawBody: string = pickedPlain
    rawBody = unwrapMicrosoftGraphBody(rawBody)
    if (!rawBody.trim() && pickedPlain.trim()) {
      console.warn('[body] unwrap で空のため pickedPlain にフォールバック', { picked_len: pickedPlain.length })
      rawBody = pickedPlain.trim()
    }
    // HTMLタグが含まれている場合は除去してプレーンテキスト化
    let body: string = rawBody.includes('<html') || rawBody.includes('<div') || rawBody.includes('<p ')
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
      console.log('[STEP3 attach]', { name: att.name, mimeType: att.mimeType, dataLen: att.data?.length ?? 0, isWordByMime, isExcelByMime, isWordByExt, isExcelByExt })
      if (isWordByMime || isWordByExt) {
        const text = await extractWordText(att.data)
        if (text.trim()) officeTextContents.push({ label: `Word文書(${att.name ?? 'document'})`, content: text })
        else console.warn(`[Word] 抽出結果が空: ${att.name} mimeType=${att.mimeType}`)
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

    // poll-email から呼ばれた場合は既に分類済みのためスキップ
    const skipRelevance = raw.skip_relevance === 'true' || raw.skip_relevance === '1'
    if (!skipRelevance && isInboundRelevanceCheckEnabled()) {
      tracePhase = 'relevance_check'
      pipe(traceRid, tracePhase, { type, inboundDataEnv })
      try {
        const { relevant, durationMs: relevanceDurationMs, usedModel: relevanceModel } = await classifyInboundRelevance({
          subject,
          from,
          body,
          inboundType: type,
          attachmentCount: attachments.length,
          attachmentMimeTypes: attachments.map((a) => a.mimeType || ''),
          traceRid,
        })
        tracePhase = 'relevance_done'
        console.log('[RELEVANCE] 判定結果', { rid: traceRid, relevant, durationMs: relevanceDurationMs, model: relevanceModel })

        // ai_logs に記録（失敗してもメイン処理は継続）
        supabase.from('ai_logs').insert({
          type: 'relevance_check',
          model: relevanceModel,
          from_address: from,
          subject,
          ai_result: { relevant },
          prompt_length: body.slice(0, 8000).length + subject.length,
          status: 'success',
          duration_ms: relevanceDurationMs,
        }).then(({ error }) => {
          if (error) console.error('[RELEVANCE] ai_logs insert失敗', error.message)
        })

        if (!relevant) {
          tracePhase = 'skip_not_relevant'
          console.warn('[RELEVANCE] 無関係のためスキップ（200）', {
            rid: traceRid,
            subject,
            from: from.slice(0, 120),
          })
          return new Response(
            JSON.stringify({
              ok: true,
              skipped: true,
              reason: 'NOT_RELEVANT_CONTENT',
              message: '無関係メールと判定したため取り込みをスキップしました（Make の後続処理は続行できます）',
              type,
              inboundDataEnv,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            },
          )
        }
      } catch (e) {
        console.warn('[RELEVANCE] 判定エラー、本処理へ続行', e)
      }
    }

    tracePhase = 'pre_supabase'

    // ③ 重複メール判定（同一メールが複数受信箱に転送された場合の二重処理防止）
    // dedup_salt: poll-email が添付分割する際に添付ファイル名を渡す（分割呼び出し間の衝突を防ぐ）
    const dedupSalt = raw.dedup_salt ?? ''
    tracePhase = 'dedup_check'
    const isDuplicate = await checkAndMarkEmailDuplicate(supabase, from, subject, body, dedupSalt)
    if (isDuplicate) {
      console.warn('[DEDUP] 重複メールのためスキップ', { rid: traceRid, subject, from: from.slice(0, 80) })
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'DUPLICATE_EMAIL' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    tracePhase = 'drive_links_fetch'
    pipe(traceRid, tracePhase)
    // Google Drive / Sheets / Docs リンクの取得
    console.log(`[STEP4 DriveLink開始] elapsed=${elapsed()}`, { rid: traceRid })
    const { textContents: driveTexts, pdfAttachments: drivePdfs } = await fetchGoogleLinks(body)
    const rawAllAttachments = [...supportedAttachments, ...drivePdfs]
    tracePhase = 'drive_links_done'
    console.log('[STEP4 DriveLink完了]', {
      rid: traceRid,
      texts: driveTexts.map(t => ({ label: t.label, length: t.content.length })),
      pdfs: drivePdfs.map(p => p.name),
      elapsed: elapsed(),
    })

    // ---- PDF テキスト抽出（2段階処理）----
    // PDFバイナリをGeminiでテキスト化 → Groqで構造化抽出できるようにする
    tracePhase = 'pdf_extract'
    const pdfAttachmentsOnly = rawAllAttachments.filter(a => a.mimeType === 'application/pdf')
    const nonPdfAttachments = rawAllAttachments.filter(a => a.mimeType !== 'application/pdf')
    const { extractedTexts: pdfExtractedTexts, remainingPdfs } = await extractPdfTextsWithGemini(pdfAttachmentsOnly, traceRid)
    // 変換成功PDFはテキストに、失敗PDFはバイナリのまま残す
    const allAttachments = [...nonPdfAttachments, ...remainingPdfs]

    // ① 複雑度に応じてモデルを選択（コスト最適化）
    // シンプル: 添付なし・Driveリンクなし・本文2000文字以下 → gemini-2.0-flash（安価）
    // 複雑:    添付あり・Driveリンクあり・長文 → gemini-2.5-flash（精度重視）
    const hasAttachments = attachments.length > 0 || drivePdfs.length > 0
    const hasDriveLinks = driveTexts.length > 0
    const isLongBody = body.length > 2000
    const isComplex = hasAttachments || hasDriveLinks || isLongBody
    const extractModel = isComplex ? AI_MODEL : AI_MODEL_FAST

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

      // 添付ファイルを Supabase Storage にアップロード（resume_urlが未設定の場合に優先設定）
      for (const att of attachments) {
        if (!att.data) continue
        const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        const filename = att.name ? `${ts}_${att.name}` : `${ts}_resume.${att.mimeType.split('/')[1] ?? 'bin'}`
        const url = await uploadToStorage(filename, att.mimeType, att.data)
        if (url && !resumeUrl) resumeUrl = url
      }
    }

    // Drive取得テキスト + Officeテキスト + PDF抽出テキストを統合してプロンプトに追記
    const allTextContents = [...driveTexts, ...officeTextContents, ...pdfExtractedTexts]
    const driveTextSection = allTextContents.length > 0
      ? '\n\n' + allTextContents.map(t => `--- ${t.label} ---\n${t.content.slice(0, 3000)}`).join('\n\n')
      : ''

    const allAttachmentNames = [
      ...allAttachments.map(a => a.name ?? a.mimeType),
      ...officeTextContents.map(t => t.label),
    ]
    const attachmentNote = allAttachmentNames.length > 0
      ? `\n※添付ファイル（${allAttachmentNames.join('、')}）も含めて解析してください。`
      : ''

    // ── 人材メール ────────────────────────────────────────────
    if (type === 'candidate' || type === 'human') {
      // ファイル名から氏名を推測
      const extractNameFromFilename = (filename: string): string | null => {
        if (!filename) return null
        // 拡張子を除去
        const nameWithoutExt = filename.replace(/\.[^/.]+$/, '')
        // アンダースコアやハイフンで分割し、最後の部分を氏名候補とする
        const parts = nameWithoutExt.split(/[_-]/)
        const lastPart = parts[parts.length - 1]
        // 日本語の姓名パターン（2-4文字の漢字ひらがなカタカナ）にマッチするかチェック
        if (/^[ぁ-んァ-ン一-龯]{2,4}$/.test(lastPart)) {
          return lastPart
        }
        // アルファベット+数字のパターン（例: OH_一之江 → 一之江）
        const match = nameWithoutExt.match(/[a-zA-Z_]+([ぁ-んァ-ン一-龯]{2,4})/)
        if (match) return match[1]
        return null
      }

      const filenameCandidates: string[] = []
      for (const att of allAttachments) {
        if (att.name) {
          const extracted = extractNameFromFilename(att.name)
          if (extracted) filenameCandidates.push(extracted)
        }
      }
      const filenameNote = filenameCandidates.length > 0
        ? `\n※ファイル名から推測される氏名候補: ${filenameCandidates.join('、')}`
        : ''

      const prompt = `
これは営業担当者が転送・送付した人材紹介メールです。${attachmentNote}${filenameNote}
差出人（${from}）は営業担当者であり、候補者本人ではありません。

【重要ルール】
- 本文または添付ファイルに明示的に書かれている情報だけを抽出してください。
- 書かれていない情報は絶対に推測・補完・でっち上げをしないでください。

【氏名の抽出ルール】
- 氏名はPDFや本文の「テキスト内容」から読み取ってください。
- 添付ファイルのファイル名に姓名が明記されている場合（例: 山田太郎.pdf）は、ファイル名から氏名を抽出してください。ただし、拡張子や記号を除去し、人名として妥当な部分のみを使用してください。
- ファイル名から推測される氏名候補が提供される場合がありますが、これはヒントとして参考にしてください。駅名やイニシャルなどが混入している可能性があるため、必ず本文・PDFの内容と照合して判断してください。
- 文字化けしている文字列（例：㻻㻴、㼃indows、㻼㻴㻼 等）は正しく読み取れていません。これらを氏名として使わないでください。
- PDFは複数ページある場合があります。必ず全ページを確認してください。
- 学歴/職歴ページ（最終ページ付近）に「フリガナ」「氏名」が明記されている場合、そのページの情報を最優先で使用してください。
- イニシャル（例: O.H., T.Y.、またはМ・T や A・B のような中点区切り形式）が明記されている場合は、それを氏名としてそのまま使用してください。フルネームが同じ文書内で見つからない場合でもイニシャルを有効とします。
- 地名・駅名・会社名を氏名と混同しないでください。
- 氏名が本文・添付テキスト・ファイル名に一切見つからない場合のみ "不明" にしてください。

【メールアドレスの抽出ルール】
- emailは候補者本人のアドレスのみです。
- 差出人（${from}）は営業担当者のため、このアドレスは絶対に入れないでください。
- PDFや本文に候補者のメールアドレスが書かれていなければ必ず null にしてください。

【その他のルール】
- 電話番号も明記されているものだけ。なければ null。
- skillsはIT系に限らず、職種問わず本文・添付に明記されたスキル・ツール・知見を全て抽出してください。
  例: ITエンジニア系（PHP, Java, MySQL等）はもちろん、
  デザイン系（Illustrator, Photoshop, Figma, After Effects等）、
  ビジネス系（Excel, PowerPoint, Salesforce等）、
  知見・専門性（グラフィックデザイン, WEBデザイン, 動画編集, ECサイト運営等）も含めてください。
- 本文中で「/」「・」「,」「、」で区切られたスキルは必ず個別に分割して抽出してください。
  例:「Illustrator / Photoshop / Figma」→ ["Illustrator", "Photoshop", "Figma"]
  例:「グラフィックデザイン / WEBデザイン / 動画編集」→ ["グラフィックデザイン", "WEBデザイン", "動画編集"]
- skillsは重複なしで返してください。表記が異なっても同じ技術は1つにまとめ、より一般的な表記に統一してください。
- experienceYearsは職歴の最初の年から現在までの年数を計算してください。
  備考欄や本文に「デザイン歴20年」「経験年数○年」等の明記があればその値を優先してください。
- summaryは具体的な社名・プロジェクト名・実績・受賞歴を必ず含めてください。

件名: ${subject}

【スキル正規化ルール】
※このリストは「表記ゆれを統一するための参考」です。リストにあるスキルを新たに追加してはいけません。
本文・添付に明記されているスキルのみ抽出し、以下の表記に統一してください：
- Javascript / JS → JavaScript
- Mysql / MYSQL → MySQL
- PostageSQL / Postgre → PostgreSQL
- Salesforce / saleforce → Salesforce
- Powerpoint → PowerPoint
- After effect / AfterEffects → After Effects
- Premiere / PremierePro → Premiere Pro

【地域・勤務地に関するルール】
- nearestStation: 「基本情報」や「最寄駅」フィールドから記載された駅名を抽出。都道府県名も含めます。例: "北海道 麻生駅"。記載がなければ null。
- prefecture: nearestStation から都道府県を抽出。例: "北海道"、"東京都"。記載がなければ null。
- availableRegions: 就業可能な地域（都道府県単位）。居住地（prefecture）がある場合は必ず含めてください。例: ["北海道", "東京都"]。
- currentWorkLocation: 現在の拠点。prefecture または nearestStation が判明している場合は、その都道府県を必ず設定してください。例: "北海道"。
- remoteAvailable: 本文やサマリーに「リモート希望」「リモート勤務」「フリーランス」等の記載があれば true。明記がなければ false。

抽出項目（JSON形式のみで返してください。前後に余分なテキスト不要）:
- name: string（フルネーム。ファイル名・文字化け文字列は使わない。不明なら "不明"）
- email: string | null（候補者本人のみ。なければ null）
- phone: string | null（明記されたもののみ。なければ null）
- skills: string[]（職種問わず明記されているもののみ。重複なし。正規化済み。なければ[]）
- skillsByCategory: object（skillsを以下の14カテゴリに分類。該当なしは[]）
  【カテゴリ厳守ルール】以下の14カテゴリキーのみ使用すること。それ以外のキーは絶対に追加しないこと。どのカテゴリにも当てはまらないスキルはすべて others に入れること。
  - languages: string[]（プログラミング言語・クエリ言語。例: PHP, Java, Python, SQL, HTML/CSS）
  - frameworks: string[]（Webフレームワーク・アプリFW等。例: Laravel, React, Vue, Spring）
  - libraries: string[]（ライブラリ、UIキット等。例: jQuery, Bootstrap, NumPy）
  - os: string[]（OS。例: Linux, Windows, MacOS, Unix）
  - databases: string[]（RDB, NoSQL, KVS等。例: MySQL, PostgreSQL, MongoDB, Redis）
  - dwh: string[]（データウェアハウス・分析基盤。例: BigQuery, Snowflake, Redshift, dbt, Looker, Tableau, Power BI）
  - clouds: string[]（クラウドサービス。例: AWS, Azure, GCP, Firebase）
  - infrastructures: string[]（インフラ技術。例: Docker, Kubernetes, Terraform, Nginx, Apache, CI/CD）
  - tools: string[]（開発・業務ツール。例: Git, Jira, Slack, Notion, Salesforce, Excel, PowerPoint）
  - methodologies: string[]（手法・マネジメント。例: アジャイル, スクラム, 要件定義, 企画立案, ディレクション, PM）
  - certifications: string[]（資格試験等。例: AWS認定, 情報処理技術者, TOEIC）
  - design: string[]（デザイン・クリエイティブ。例: Illustrator, Photoshop, Figma, XD, After Effects, Premiere Pro, グラフィックデザイン, 動画編集）
  - marketing: string[]（マーケティング・集客。例: SEO, SNS運用, Web広告, ECサイト運営, デジタルマーケティング）
  - others: string[]（上記14カテゴリに当てはまらないもの全て）
- roles: string[]（担当役割・職種。例: ["PM", "グラフィックデザイナー", "クリエイティブディレクター", "ITコンサル"]。明記されているもののみ）
- industries: string[]（業界経験。例: ["通信", "金融", "広告", "EC"]。職歴・本文から読み取れるもの）
- experienceYears: number | null（計算または明記された値。なければ null）
- summary: string（職務経歴の概要300字以内。社名・実績・受賞歴を含めること）
- nearestStation: string | null（最寄駅。都道府県を含む形式。例: "北海道 麻生駅"。記載がなければ null）
- prefecture: string | null（都道府県。例: "北海道"。記載がなければ null）
- availableRegions: string[] | null（就業可能な地域。例: ["北海道", "東京都"]。情報がなければ null）
- currentWorkLocation: string | null（現在の拠点都道府県。例: "北海道"。情報がなければ null）
- remoteAvailable: boolean（リモート勤務対応可否。「リモート希望」等の明記で true。記載なければ false）
- desiredRate: string | null（希望単価・希望年収。例: "60万円/月"、"700万円/年"。記載なければ null）
- fromCompany: string | null（紹介元・送信元の会社名。差出人のメール本文・署名から抽出。なければ null）

本文:
${body.slice(0, 3000)}${driveTextSection}

JSON:`.trim()

      tracePhase = 'gemini_candidate_extract'
      pipe(traceRid, tracePhase, { promptLen: prompt.length, attachmentParts: allAttachments.length })

      let durationMs: number
      let parseFallback: 'none' | 'body_only_after_attachment_timeout' = 'none'
      type CandAi = {
        name: string; email: string | null; phone: string | null
        skills: string[]
        skillsByCategory: {
          languages: string[]; frameworks: string[]; libraries: string[]; os: string[]
          databases: string[]; dwh: string[]; clouds: string[]; infrastructures: string[]
          tools: string[]; methodologies: string[]; certifications: string[]
          design: string[]; marketing: string[]; others: string[]
        }
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
      let analyzed: CandAi
      let usedModel1: string | undefined

      try {
        const candidateGroqPrompt = buildCandidateGroqPrompt(from, subject, body, allTextContents)
        const { result, durationMs: d1, usedModel: _usedModel1 } = await generateJSONSmart(prompt, allAttachments, 'candidate', 2, undefined, {
          rid: traceRid,
          phase: 'gemini_candidate_extract',
        }, extractModel, candidateGroqPrompt)
        usedModel1 = _usedModel1
        durationMs = d1
        analyzed = result as CandAi
        tracePhase = 'gemini_candidate_done'

        // 品質チェック：添付ありでスキル0件 → 本文のみで再解析
        // 名前が取れていてもスキルが0の場合は添付が邪魔している可能性があるため再試行する
        const qualityPoor = allTextContents.length > 0 &&
          (analyzed.skills?.length ?? 0) === 0
        if (qualityPoor) {
          tracePhase = 'candidate_extract_body_only_retry'
          console.warn('[candidate] 品質不足(添付あり)→本文のみで再解析', { rid: traceRid, name: analyzed.name })
          const promptBodyOnly = driveTextSection.length > 0
            ? prompt.replace(driveTextSection, '')
            : prompt
          const bodyOnlyGroqPrompt = buildCandidateGroqPrompt(from, subject, body, [])
          const { result: r2, durationMs: d2, usedModel: um2 } = await generateJSONSmart(
            promptBodyOnly, [], 'candidate', 2, undefined,
            { rid: traceRid, phase: 'candidate_extract_body_only_retry' },
            extractModel, bodyOnlyGroqPrompt,
          )
          analyzed = r2 as CandAi
          durationMs = d2
          usedModel1 = um2
          parseFallback = 'body_only_after_attachment_timeout'
          tracePhase = 'gemini_candidate_done_body_only'
        }
      } catch (e) {
        const msg = String(e)
        const canFallback =
          isCandidateBodyFallbackOnTimeoutEnabled() &&
          allAttachments.length > 0 &&
          msg.includes('Gemini APIタイムアウト')
        if (!canFallback) throw e

        tracePhase = 'gemini_candidate_extract_body_only'
        pipe(traceRid, tracePhase, { rid: traceRid })
        console.warn('[candidate] 添付付きGeminiがタイムアウト。本文・Drive・Officeテキストのみで再試行', { rid: traceRid })
        const slimPrompt = `${prompt}

【システム通知】初回解析がタイムアウトしたため、画像・PDF添付バイナリは参照していません。メール本文・Driveリンク由来テキスト・Office抽出テキストのみを根拠に抽出してください。推測はしないでください。`
        const { result, durationMs: d2, usedModel: usedModel2 } = await generateJSONSmart(slimPrompt, [], 'candidate', 2, undefined, {
          rid: traceRid,
          phase: 'gemini_candidate_extract_body_only',
        }, extractModel)
        durationMs = d2
        analyzed = result as CandAi
        parseFallback = 'body_only_after_attachment_timeout'
        tracePhase = 'gemini_candidate_done_body_only'
      }


      // スキル重複除去（trim + 大文字小文字を無視して正規化）
      const skills = Array.from(
        new Map(
          (analyzed.skills ?? [])
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0)
            .map((s: string) => [s.toLowerCase(), s])
        ).values()
      )

      // 送信者メールアドレスが混入していたら除去
      const senderEmails = from.split(/[,;]/).map((s: string) => s.trim().toLowerCase())
      const email = analyzed.email && !senderEmails.includes(analyzed.email.toLowerCase())
        ? analyzed.email
        : null

      const dbPayload = {
        data_env: inboundDataEnv,
        name: analyzed.name ?? '不明',
        email,
        phone: analyzed.phone ?? null,
        skills,
        experience_years: toExperienceYears(analyzed.experienceYears),
        raw_profile: {
          text: body.slice(0, 5000),
          summary: analyzed.summary ?? '',
          skillsByCategory: analyzed.skillsByCategory ?? {
            languages: [], frameworks: [], libraries: [], os: [],
            databases: [], dwh: [], clouds: [], infrastructures: [],
            tools: [], methodologies: [], certifications: [],
            design: [], marketing: [], others: [],
          },
          roles: analyzed.roles ?? [],
          industries: analyzed.industries ?? [],
          nearestStation: analyzed.nearestStation ?? null,
          prefecture: analyzed.prefecture ?? null,
          availableRegions: analyzed.availableRegions ?? null,
          currentWorkLocation: analyzed.currentWorkLocation ?? null,
          remoteAvailable: analyzed.remoteAvailable ?? false,
          from, subject,
          attachmentCount: allAttachments.length,
          attachmentNames: [
            ...allAttachments.map(a => a.name ?? a.mimeType),
            ...officeTextContents.map(t => t.label),
          ],
          driveLinks: driveTexts.map(t => t.label),
          aiAnalysis: analyzed,
          geminiParseFallback: parseFallback,
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
        box_url: boxUrls[0] ?? null,
        box_status: boxUrls.length > 0 ? 'pending' : null,
        resume_url: resumeUrl,
        desired_rate: analyzed.desiredRate ?? null,
        from_company: analyzed.fromCompany ?? null,
      }

      const { data, error } = email
        ? await supabase.from('candidates').upsert(dbPayload, { onConflict: 'email' }).select().single()
        : await supabase.from('candidates').insert(dbPayload).select().single()

      if (error) throw new Error(`候補者保存エラー: ${error.message}`)

      // candidate_skills に一括INSERT
      const validCategories = [
        'languages', 'frameworks', 'libraries', 'os',
        'databases', 'dwh', 'clouds', 'infrastructures',
        'tools', 'methodologies', 'certifications',
        'design', 'marketing', 'others',
      ]
      const skillsPayload: { candidate_id: string; category: string; skill: string }[] = []
      const categoryMap = analyzed.skillsByCategory ?? {}
      for (const category of validCategories) {
        const skillList: string[] = (categoryMap as Record<string, string[]>)[category] ?? []
        for (const skill of skillList) {
          if (skill && skill.trim()) skillsPayload.push({ candidate_id: data.id, category, skill: skill.trim() })
        }
      }
      if (skillsPayload.length > 0) {
        await supabase.from('candidate_skills').delete().eq('candidate_id', data.id)
        const { error: skillsError } = await supabase.from('candidate_skills').insert(skillsPayload)
        if (skillsError) console.error('[candidate_skills INSERT error]', skillsError)
        else { /* スキル登録完了 */ }
      }

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'candidate',
        model: usedModel1 ?? extractModel,
        from_address: from,
        subject,
        ai_result: analyzed,
        prompt_length: prompt.length,
        status: 'success',
        duration_ms: durationMs,
        linked_id: data.id,
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      // Box URLがあればスプレッドシートに書き込む（失敗してもメイン処理は継続）
      if (boxUrls.length > 0) {
        await appendToBoxSpreadsheet(boxUrls)
      }

      console.log(`[inbound] 人材登録完了: ${data.name}`)
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
      if (projectEnabledRow?.value !== 'true') {
        console.log('[inbound] 案件メール解析は無効のためスキップ', { rid: traceRid, subject })
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: 'PROJECT_INBOUND_DISABLED' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      const prompt = `
これは営業担当者が転送・送付した業務委託・派遣・開発案件などの依頼メールです。${attachmentNote}
差出人（${from}）は営業または元請け担当者であることがあります。本文・添付・以下の参考テキストに書かれた内容だけを根拠に抽出してください。

【重要ルール】
- 明示されている情報だけを抽出し、推測・でっち上げはしないでください。
- requiredSkills には「必須」「必須スキル」に相当するもののみ。尚可・歓迎・あれば尚可は niceToHaveSkills に入れてください。
- スキル列の区切り（「/」「・」,「、」）は必ず分割し、重複は除き、一般的な表記に統一してください（例: Javascript→JavaScript, Mysql→MySQL）。
- budgetMin / budgetMax は月額単価の万円（数値のみ）。「60万」「60万円」は 60。年収・日額と本文で明記されている場合のみそれに従い、曖昧なら null。
- startDate / endDate は YYYY-MM-DD のみ。和暦や「4月上旬」だけでは null（西暦の確定日がある場合のみセット）。
- headcount は募集人数の整数（「2名」→2）。不明なら null。
- settlementMin / settlementMax は本文に明記された精算の下限・上限を数値化できる場合のみ（例: 1日8時間→8、月次精算レンジ140〜180→140と180）。単位が曖昧なら null。
- workLocation / remotePolicy / contractType / workload / roleSummary / industry は記載がある場合のみ短く要約。なければ null。
- **1つのメール・1つの文書の中に複数の独立した募集案件がある場合**は、各案件を1要素とする **JSON配列** で返してください（例: [{...},{...}]）。
- **案件が1件だけ**の場合は、オブジェクト1つ **または** 要素1つの配列のどちらでも構いません。

件名: ${subject}

抽出項目（各案件オブジェクトのフィールド。JSON形式のみ。前後に余分なテキスト不要）:
- title: string（案件名。件名・本文見出しを優先。不明なら "案件"）
- client: string | null（エンド・クライアント名。不明なら null）
- description: string（作業内容・背景・場所・勤務形態などの要約。なければ ""）
- requiredSkills: string[]（必須スキル・ツール。なければ[]）
- niceToHaveSkills: string[]（尚可・歓迎。なければ[]）
- budgetMin: number | null（月額・万円）
- budgetMax: number | null（月額・万円）
- startDate: string | null（YYYY-MM-DD）
- endDate: string | null（YYYY-MM-DD）
- workLocation: string | null（勤務地・オフィス・エリア）
- remotePolicy: string | null（フルリモート可・週○出社・常駐など）
- contractType: string | null（業務委託・派遣・準委任・請負など）
- headcount: number | null
- workload: string | null（週5日・月20日など稼働の目安）
- settlementMin: number | null
- settlementMax: number | null
- roleSummary: string | null（PL/SE/PG・リーダー等）
- industry: string | null（金融・製造・EC 等）

本文:
${body.slice(0, 3000)}${driveTextSection}

JSON:`.trim()

      tracePhase = 'gemini_project_extract'
      pipe(traceRid, tracePhase, { promptLen: prompt.length, attachmentParts: allAttachments.length })
      const projectGroqPrompt = buildProjectGroqPrompt(subject, body, allTextContents)
      const { result, durationMs, usedModel: usedModelP } = await generateJSONSmart(prompt, allAttachments, 'project', 2, undefined, {
        rid: traceRid,
        phase: 'gemini_project_extract',
      }, extractModel, projectGroqPrompt)
      tracePhase = 'gemini_project_done'

      const projectObjects = normalizeToProjectObjects(result)
      if (projectObjects.length === 0) {
        throw new Error('案件解析結果が空、または形式が不正です（オブジェクトまたは配列を期待）')
      }

      const sharedRawMeta = {
        text: body.slice(0, 5000),
        from,
        subject,
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

      // ── 案件登録後：自動マッチング（①） ─────────────────────────────────
      // 参画確定(=submissions.status='accepted') の人材は以後のマッチング対象から除外して軽量化する
      if (AUTO_MATCH_ENABLED) {
        try {
          const { data: acceptedRows, error: acceptedErr } = await supabase
            .from('submissions')
            .select('candidate_id')
            .eq('data_env', inboundDataEnv)
            .eq('status', 'accepted')
            .limit(10000)

          if (acceptedErr) throw new Error(`accepted人材取得エラー: ${acceptedErr.message}`)
          const acceptedCandidateIds = new Set<string>(
            (acceptedRows ?? [])
              .map((r) => (r as { candidate_id?: string }).candidate_id)
              .filter((x): x is string => typeof x === 'string' && x.length > 0),
          )

          let candidatesTotal = 0

          for (const p of insertedRows as any[]) {
            const requiredSkills = Array.isArray(p.required_skills) ? p.required_skills.map(String).filter(Boolean) : []

            // まずは「必須スキルが1つでも重なる」人材だけに絞る（無い場合は全体から上限だけ）
            let candQuery = supabase
              .from('candidates')
              .select('id, name, email, phone, skills, experience_years, raw_profile, merged_into')
              .eq('data_env', inboundDataEnv)
              .is('merged_into', null)
              .limit(AUTO_MATCH_MAX_CANDIDATES)

            if (requiredSkills.length > 0) {
              // PostgREST: overlaps 演算子
              candQuery = candQuery.overlaps('skills', requiredSkills)
            }

            const { data: candidates, error: candErr } = await candQuery
            if (candErr) throw new Error(`候補者取得エラー: ${candErr.message}`)

            candidatesTotal += (candidates ?? []).length

            const targetCandidates = (candidates ?? [])
              .map((c) => c as any)
              .filter((c) => !acceptedCandidateIds.has(String(c.id)))

            console.log(
              `[AUTO_MATCH] project=${p.id} requiredSkills=${requiredSkills.length} candidatesFetched=${(candidates ?? []).length} accepted_locked=${acceptedCandidateIds.size} target=${targetCandidates.length}`,
            )

            const niceToHaveSkills = Array.isArray(p?.raw_data?.niceToHaveSkills)
              ? p.raw_data.niceToHaveSkills.map(String).filter(Boolean)
              : []

            const projectRequirements: Record<string, unknown> = {
              title: p.title,
              client: p.client,
              description: p.description,
              requiredSkills,
              niceToHaveSkills,
              budgetMin: p.budget_min ?? null,
              budgetMax: p.budget_max ?? null,
              workLocation: p.work_location ?? null,
              remotePolicy: p.remote_policy ?? null,
              contractType: p.contract_type ?? null,
              roleSummary: p.role_summary ?? null,
              industry: p.industry ?? null,
            }

            for (const c of targetCandidates) {
              const candidateProfile: Record<string, unknown> = {
                name: c.name,
                email: c.email ?? null,
                phone: c.phone ?? null,
                skills: c.skills ?? [],
                experienceYears: c.experience_years ?? null,
                summary: typeof c.raw_profile?.summary === 'string' ? c.raw_profile.summary : '',
              }

              tracePhase = 'gemini_auto_match_loop'
              const mr = await matchCandidateToProject(candidateProfile, projectRequirements, {
                rid: traceRid,
              })

              const { error: upsertErr } = await supabase
                .from('submissions')
                .upsert(
                  {
                    data_env: inboundDataEnv,
                    candidate_id: c.id,
                    project_id: p.id,
                    match_score: mr.score,
                    ai_summary: mr.summary,
                    ai_raw: { duplicateSuspected: mr.duplicateSuspected, autoMatched: true },
                    created_by: 'make-inbound',
                  },
                  { onConflict: 'candidate_id,project_id' },
                )

              if (upsertErr) console.error('[AUTO_MATCH] submissions upsert error', upsertErr)
            }
          }

          console.log(`[AUTO_MATCH] done projects=${insertedRows.length} candidatesFetchedTotal=${candidatesTotal}`)
        } catch (e) {
          console.error('[AUTO_MATCH] failed', e)
        }
      }

      const logResults = await Promise.all(
        insertedRows.map((row, i) =>
          supabase.from('ai_logs').insert({
            type: 'project',
            model: AI_MODEL,
            from_address: from,
            subject,
            ai_result: { ...projectObjects[i], batchIndex: i, batchSize: projectObjects.length },
            prompt_length: prompt.length,
            status: 'success',
            duration_ms: durationMs,
            linked_id: row.id,
          })
        ),
      )
      for (const lr of logResults) {
        if (lr.error) console.error('[ai_logs INSERT error]', lr.error)
      }

      console.log(
        `[inbound] 案件登録完了: ${insertedRows.length}件 — ${insertedRows.map((r) => r.title).join(', ')}`,
      )
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
      await supabase.from('ai_logs').insert({
        type: 'unknown',
        model: AI_MODEL,
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