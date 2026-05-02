// Supabase Edge Function: Make.com (Outlook) → AI解析 → DB保存
// Runtime: Deno / タイムアウト: 最大150秒（Vercel Hobbyの10秒制限を回避）
// POST body (form-urlencoded or JSON):
//   type, from, subject, body
//   mode または data_env: prod | demo | dev（dev は demo と同じ。省略時は prod）
//   ?mode=demo や ?data_env=demo（Webhook URL のクエリ）も可（ボディが空のとき補完）
//   ヘッダ X-Data-Env / X-Mode も補完として利用可
//   attachment[data], attachment[mimeType], attachment[name]
//   本文・添付とも空: HTTP 200 + skipped（Make 継続）。DB は書かない。
//   INBOUND_RELEVANCE_CHECK: false で事前の無関係メール判定を無効化（既定は true）
//   GEMINI_INBOUND_TIMEOUT_MS: candidate/project の1回あたり ms（未設定時 38000。長い解析は Make の HTTP タイムアウトも延長）

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

const AI_MODEL = 'gemini-2.5-flash'

/** candidate/project の 1 回あたり上限（ms）。Supabase Secrets: GEMINI_INBOUND_TIMEOUT_MS（例: 38000） */
function resolveInboundGeminiTimeoutMs(kind: 'candidate' | 'project' | 'match', override?: number): number {
  if (override != null) return override
  if (kind === 'match') return 25_000
  const raw = (Deno.env.get('GEMINI_INBOUND_TIMEOUT_MS') ?? '').trim()
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10)
    return Math.min(120_000, Math.max(15_000, n))
  }
  // Make.com HTTP 既定 40s 超えにくいようやや短め（長い解析は Make 側タイムアウト延長も推奨）
  return 38_000
}

function isInboundRelevanceCheckEnabled(): boolean {
  return (Deno.env.get('INBOUND_RELEVANCE_CHECK') ?? 'true').toLowerCase() !== 'false'
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
}): Promise<{ relevant: boolean; durationMs: number }> {
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
  pipe(rid, 'relevance_gemini_wait', { inboundType: input.inboundType })

  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL, generationConfig: { temperature: 0 } })
  const TIMEOUT_MS = 15_000
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
    return { relevant: true, durationMs }
  }
  const r = parsed.relevant
  const relevant = typeof r === 'boolean' ? r : true
  return { relevant, durationMs }
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
): Promise<{ result: unknown; durationMs: number }> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL, generationConfig: { temperature: 0 } })

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

/** Word(.docx)をテキストに変換 */
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
    console.warn('[Word] テキスト抽出失敗', e)
    return ''
  }
}

/** Excel(.xlsx/.xls)をCSVテキストに変換（最初の3シートまで） */
async function extractExcelText(base64: string): Promise<string> {
  try {
    const XLSX = npmDefault(await import('npm:xlsx@0.18.5')) as {
      read: (data: Uint8Array, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
      utils: { sheet_to_csv: (sheet: unknown) => string }
    }
    const bytes = base64ToUint8Array(base64)
    const workbook = XLSX.read(bytes, { type: 'array' })
    const texts: string[] = []
    for (const sheetName of workbook.SheetNames.slice(0, 3)) {
      const sheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(sheet)
      if (csv.trim()) {
        texts.push(`--- シート: ${sheetName} ---\n${csv}`)
      }
    }
    return texts.join('\n\n')
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
        console.warn(`[DriveLink] Sheetsエクスポート失敗(${res.status}): ${id} - 通常のDrive取得へフォールバックします`)
        const driveRes = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${id}`)
        if (driveRes.ok) {
          const text = await driveRes.text()
          textContents.push({ label: `Googleスプレッドシート(DL:${id})`, content: text })
        }
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

  // Google Drive ファイル → PDF or テキスト
  const driveMatches = driveMatchesPreview
  for (const match of driveMatches) {
    const id = match[1]
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${id}`
    try {
      const res = await fetchWithTimeout(downloadUrl)
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('pdf')) {
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          pdfAttachments.push({ data: b64, mimeType: 'application/pdf', name: `drive_${id}.pdf` })
          console.log(`[DriveLink] Drive PDF取得成功: ${id}`)
        } else if (ct.includes('text') || ct.includes('csv')) {
          textContents.push({ label: `Driveファイル(${id})`, content: await res.text() })
          console.log(`[DriveLink] Drive text取得成功: ${id}`)
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
          console.log('[multipart] file field', {
            field: k,
            bytes: ab.byteLength,
            mime,
            fileName,
          })
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
    console.log('[STEP0 受信メタ]', {
      rid: traceRid,
      method: req.method,
      contentType,
      rawKeyCount: rawKeys.length,
      rawKeys,
      rawType: raw.type ?? '(unset)',
      rawMode: raw.mode ?? '(unset)',
      pickedMode: pickedMode ?? '(unset)',
      queryHasMode,
    })
    console.log('[STEP0 フィールド長]', {
      rid: traceRid,
      raw_body_len: (raw.body ?? '').length,
      picked_plain_len: pickEmailPlainBody(raw).length,
      attachment_data_len: (raw['attachment[data]'] ?? '').length,
      attachment_mime: (raw['attachment[mimeType]'] ?? '').slice(0, 80),
    })

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
        const parsed = JSON.parse(raw.attachmentsJson)
        if (Array.isArray(parsed)) attachments = parsed
      } catch { /* ignore */ }
    }

    const t0 = Date.now()
    const elapsed = () => `${Date.now() - t0}ms`

    tracePhase = 'step1_body_normalized'
    console.log('[STEP1 受信データ]', {
      rid: traceRid,
      type, from, subject,
      bodyLength: body.length,
      attachments: attachments.map(a => ({ name: a.name, mimeType: a.mimeType, dataLength: a.data?.length ?? 0 })),
    })

    const supportedAttachments = attachments.filter(a => SUPPORTED_MIME.includes(a.mimeType))
    console.log('[STEP2 添付フィルター]', {
      rid: traceRid,
      total: attachments.length,
      supported: supportedAttachments.length,
      filtered: attachments.filter(a => !SUPPORTED_MIME.includes(a.mimeType)).map(a => a.mimeType),
      elapsed: elapsed(),
    })

    // Word/Excelのテキスト抽出
    const officeTextContents: { label: string; content: string }[] = []
    for (const att of attachments) {
      if (WORD_MIME.includes(att.mimeType)) {
        console.log(`[STEP3 Office] Word変換開始: ${att.name} elapsed=${elapsed()}`)
        const text = await extractWordText(att.data)
        if (text.trim()) {
          officeTextContents.push({ label: `Word文書(${att.name ?? 'document'})`, content: text })
          console.log(`[STEP3 Office] Word変換成功: ${text.length}文字 elapsed=${elapsed()}`)
        }
      } else if (EXCEL_MIME.includes(att.mimeType)) {
        console.log(`[STEP3 Office] Excel変換開始: ${att.name} elapsed=${elapsed()}`)
        const text = await extractExcelText(att.data)
        if (text.trim()) {
          officeTextContents.push({ label: `Excelファイル(${att.name ?? 'spreadsheet'})`, content: text })
          console.log(`[STEP3 Office] Excel変換成功: ${text.length}文字 elapsed=${elapsed()}`)
        }
      }
    }
    tracePhase = 'step3_office_done'
    console.log(`[STEP3 Office完了] elapsed=${elapsed()}`)

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

    if (isInboundRelevanceCheckEnabled()) {
      tracePhase = 'relevance_check'
      pipe(traceRid, tracePhase, { type, inboundDataEnv })
      try {
        const { relevant, durationMs } = await classifyInboundRelevance({
          subject,
          from,
          body,
          inboundType: type,
          attachmentCount: attachments.length,
          attachmentMimeTypes: attachments.map((a) => a.mimeType || ''),
          traceRid,
        })
        tracePhase = 'relevance_done'
        console.log('[RELEVANCE] 判定結果', { rid: traceRid, relevant, durationMs })
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
    // STEP4 がログに出ない場合の切り分け: createClient 前後と fetchGoogleLinks 内で止まるかを分離する
    console.log('[STEP3→4間] emptyチェック通過', {
      rid: traceRid,
      bodyLen: body.trim().length,
      attachmentCount: attachments.length,
      type,
      inboundDataEnv,
      elapsed: elapsed(),
    })
    tracePhase = 'supabase_connect'
    pipe(traceRid, tracePhase)
    console.log('[STEP3→4間] Supabase createClient 直前', { rid: traceRid })
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))
    console.log('[STEP3→4間] Supabase createClient 完了', { rid: traceRid })

    tracePhase = 'drive_links_fetch'
    pipe(traceRid, tracePhase)
    // Google Drive / Sheets / Docs リンクの取得
    console.log(`[STEP4 DriveLink開始] elapsed=${elapsed()}`, { rid: traceRid })
    const { textContents: driveTexts, pdfAttachments: drivePdfs } = await fetchGoogleLinks(body)
    const allAttachments = [...supportedAttachments, ...drivePdfs]
    tracePhase = 'drive_links_done'
    console.log('[STEP4 DriveLink完了]', {
      rid: traceRid,
      texts: driveTexts.map(t => ({ label: t.label, length: t.content.length })),
      pdfs: drivePdfs.map(p => p.name),
      elapsed: elapsed(),
    })

    // Drive取得テキスト + Officeテキストを統合してプロンプトに追記
    const allTextContents = [...driveTexts, ...officeTextContents]
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
- イニシャル（例: O.H., T.Y.）が明記されている場合は、それを氏名として使用してください。フルネームが同じ文書内で見つからない場合でもイニシャルを有効とします。
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

本文:
${body.slice(0, 3000)}${driveTextSection}

JSON:`.trim()

      tracePhase = 'gemini_candidate_extract'
      pipe(traceRid, tracePhase, { promptLen: prompt.length, attachmentParts: allAttachments.length })
      console.log(`[STEP5 AI呼び出し開始] elapsed=${elapsed()}`, { rid: traceRid })
      const { result, durationMs } = await generateJSON(prompt, allAttachments, 'candidate', 2, undefined, {
        rid: traceRid,
        phase: 'gemini_candidate_extract',
      })
      tracePhase = 'gemini_candidate_done'
      console.log(`[STEP5 AI呼び出し完了] durationMs=${durationMs} elapsed=${elapsed()}`, { rid: traceRid })
      const analyzed = result as {
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
      }

      console.log(`[STEP6 AI解析結果 candidate] elapsed=${elapsed()}`, JSON.stringify(analyzed, null, 2))

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
        experience_years: analyzed.experienceYears ?? null,
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
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
      }

      console.log(`[STEP7 DB保存開始] elapsed=${elapsed()}`)
      const { data, error } = email
        ? await supabase.from('candidates').upsert(dbPayload, { onConflict: 'email' }).select().single()
        : await supabase.from('candidates').insert(dbPayload).select().single()

      if (error) throw new Error(`候補者保存エラー: ${error.message}`)
      const savedEnv = (data as { data_env?: string }).data_env
      const savedEmail = (data as { email?: string | null }).email
      console.log(`[STEP7 DB保存完了] elapsed=${elapsed()}`)
      // 原因究明用: リクエスト解決値 inboundDataEnv と、実際に返却された行の data_env が一致するか必ず照合する
      console.log('[STEP7 DB確定] 人材行', {
        candidate_id: data.id,
        data_env_intended: inboundDataEnv,
        data_env_in_row: savedEnv ?? '(null/undefined)',
        match: savedEnv === inboundDataEnv,
        email_in_row: savedEmail == null || savedEmail === '' ? 'null' : 'set',
        upsert_path: email ? 'upsert(onConflict:email)' : 'insert',
      })

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
        else console.log(`[inbound] スキル登録完了: ${skillsPayload.length}件`)
      }

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'candidate',
        model: AI_MODEL,
        from_address: from,
        subject,
        ai_result: analyzed,
        prompt_length: prompt.length,
        status: 'success',
        duration_ms: durationMs,
        linked_id: data.id,
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      console.log(`[inbound] 人材登録完了: ${data.name}`)
      return new Response(JSON.stringify({ ok: true, type: 'candidate', id: data.id, name: data.name }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 案件メール ────────────────────────────────────────────
    if (type === 'project') {
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
      console.log(`[STEP5 AI呼び出し開始 project] elapsed=${elapsed()}`, { rid: traceRid })
      const { result, durationMs } = await generateJSON(prompt, allAttachments, 'project', 2, undefined, {
        rid: traceRid,
        phase: 'gemini_project_extract',
      })
      tracePhase = 'gemini_project_done'
      console.log(`[STEP5 AI呼び出し完了 project] durationMs=${durationMs} elapsed=${elapsed()}`, { rid: traceRid })

      const projectObjects = normalizeToProjectObjects(result)
      if (projectObjects.length === 0) {
        throw new Error('案件解析結果が空、または形式が不正です（オブジェクトまたは配列を期待）')
      }

      console.log('[STEP6 AI解析結果 project]', JSON.stringify(projectObjects, null, 2))

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

    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})