// ═══════════════════════════════════════════════════════════════════════════
// 自動生成: node scripts/sync_zone_functions.mjs（直接編集しない）
// inbound-email/index.ts のゾーンA〜E/T関数を分岐網羅テスト用に抽出したもの。
// 外部依存は deps シム経由（テストがモックを注入する）。
// ═══════════════════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-explicit-any no-unused-vars

export const deps: Record<string, any> = {}
const fetchWithTimeout = (...a: any[]): Promise<Response> => deps.fetchWithTimeout(...a)
const extractExcelAll = (...a: any[]) => deps.extractExcelAll(...a)
const extractWordText = (...a: any[]) => deps.extractWordText(...a)
const extractPdfText = (...a: any[]) => deps.extractPdfText(...a)
const cleanseWordText = (t: string) => deps.cleanseWordText ? deps.cleanseWordText(t) : t
const uploadToStorage = (...a: any[]) => deps.uploadToStorage(...a)
const extractNameFallback = (...a: any[]) => deps.extractNameFallback(...a)
const extractSkillYearsFromSheetData = (...a: any[]) => deps.extractSkillYearsFromSheetData(...a)

interface Attachment { data: string; mimeType: string; name?: string }


function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

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
      // メール単位の行は少数なので、添付インベントリだけはファイル名が切れないよう長めに残す
      const emailCodes = rows.filter(r => r.entryId == null)
        .map(r => (r.detail ? `${r.code}(${r.detail.slice(0, r.code === 'A-ATT-INVENTORY' ? 400 : 60)})` : r.code))
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

const EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',                        // .xlsm（マクロ有効）
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12',                 // .xlsb（バイナリ）
]

const WORD_MIME = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.ms-word.document.macroEnabled.12',                      // .docm
]

function looksLikeZipBytes(ab: ArrayBuffer): boolean {
  const b = new Uint8Array(ab.slice(0, 2))
  return b.length >= 2 && b[0] === 0x50 && b[1] === 0x4B
}

async function fetchSheetsEntry(link: { id: string; gid: string }, ledger: Ledger): Promise<SourceEntry | null> {
  const entryId = ledger.nextEntryId()
  const fp = await fetchCsvFingerprint(link.id, link.gid)
  const sourceUrl = `https://docs.google.com/spreadsheets/d/${link.id}/edit#gid=${link.gid}`
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/spreadsheets/d/${link.id}/export?format=xlsx`, 1800)
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

async function fetchDocsEntry(link: { id: string }, ledger: Ledger): Promise<SourceEntry | null> {
  const entryId = ledger.nextEntryId()
  const sourceUrl = `https://docs.google.com/document/d/${link.id}/edit`
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/document/d/${link.id}/export?format=docx`, 1800)
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
    const res = await fetchWithTimeout(`https://docs.google.com/document/d/${link.id}/export?format=txt`, 1800)
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
    const res = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${link.id}`, 1800)
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

function colIndexFromCellRef(cell: string): number {
  const m = cell.match(/^([A-Za-z]+)/)
  if (!m) return -1
  let n = 0
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const MULTI_CANDIDATE_FIELD_RE = /【[^】]{1,10}】|[◇◆][^\n：:]{1,15}[：:]|(?:^|\n)[ 　]*[■●▪▶]?[ 　]*(?:名前|氏[ 　]*名)[　 ]*[：:]|[■●▪▶]?[ 　]*(?:最寄(?:り?駅?)|希望単価|希望単金|スキル|業務経験|稼働開始|稼働時期|アピール)/

const MULTI_NAME_FIELD_RE = /【[^】]{0,5}(?:氏名|お名前|名前|姓名|氏　名|氏　　名|名　前|名　　前)[^】]{0,5}】|【氏[^】]{0,3}】|【[ 　]*氏[ 　]*名[ 　]*】|【[ 　]*名[ 　]*前[ 　]*】|^[■●▪▶]?[ 　]*氏[ 　]*名[　 ]*[：:]|^名前[　 ]*[：:]|[◇◆]名前[　 ]*[：:]|^[■●▪▶◆◇][A-Za-zＡ-Ｚａ-ｚ.\-]{1,8}（\d+歳|^[■●▪▶◆◇][A-Za-zＡ-Ｚａ-ｚ]{1,10}[（(][^)）\d]{1,15}[）)][　 ]*(?:男性|女性|男|女)[・･]/m

function looksLikeRosterName(s: string): boolean {
  const t = s.trim()
  if (t.length < 1 || t.length > 25) return false
  // 経歴書・スキルシートの見出し語/セクション語は人名ではない。
  // 「年　数」「期　間」のような全角スペース入り見出しがすり抜けた実害があるため、
  // 判定はスペースを除去した文字列に対して行う（eyebrains 2026-08-05）
  const tNoSpace = t.replace(/[　 ]/g, '')
  // 職務経歴書の学歴欄の学校名（早稲田大学/愛知県立刈谷工科高等学校（三年制） 等）を
  // 名簿の人材行と誤認して人材登録した実害（2026-08-08 ブライトスター経歴書で量産）。
  // 「学」1字の人名（中村 学 等）は含まれないので誤爆しない
  if (/大学|高等学校|高校|学院|学校|短大|専門学校|学部|学科|卒業|入学|中退|大卒|高卒|院卒|専卒/.test(tNoSpace)) return false
  // 「勤務地」「場所」「常駐先」は案件表の列見出し。個人スキルシートの勤務地列を氏名列と
  // 誤認し、勤務地の駅名を人材として登録した実害（2026-08-10 トリニタス）
  // 「顧客」は経歴書の顧客欄セルが氏名列に並ぶと、取引先企業名の幽霊人材を量産する
  // （2026-08-11 Trinitas 経歴書で11件隔離: 日新火災・野村証券・中外製薬…）
  if (/生年月日|年月日|学歴|住所|期間|概要|案件|要件|作業|工程|役割|人数|規模|環境|備考|資格|スキル|言語|OS\b|フレームワーク|ツール|自己PR|経験|年数|性別|年齢|最寄|駅|単価|金額|稼働|開始|終了|合計|小計|通勤|沿線|会社|所属|部署|電話|メール|mail|TEL|FAX|プロジェクト|システム|開発|設計|テスト|運用|保守|担当|内容|詳細|日付|時期|現在|以上|以下|合否|評価|№|No\.?|保有|得意|分野|技術|職種|職務|要約|サマリ|紹介|実績|成果|履歴|勤務|場所|常駐|出社|拠点|顧客/i.test(tNoSpace)) return false
  // スキルシートのカテゴリ見出し（データベース/ネットワーク等のカタカナ分類語）は人名ではない。
  // 1人分のスキルシートを名簿と誤検出し、分類セルを人名行として展開する事故を防ぐ（Y.M_沼津.xlsx 実害）
  if (/^(?:データベース|ネットワーク|サーバ(?:ー)?|ミドルウェア|インフラ(?:ストラクチャ)?|クラウド|セキュリティ|ストレージ|プラットフォーム|アプリケーション|オペレーティングシステム|ハードウェア|ソフトウェア|プログラミング|マネジメント|コミュニケーション|プログラム|アーキテクチャ)$/.test(t)) return false
  // 日付・数字始まり（1989年4月、2026/05 等）は人名ではない
  if (/^[\d０-９(（]/.test(t)) return false
  // 全角英字は半角に正規化してから判定（「ＯＳ」「ＷＥＢ」が半角前提の判定をすり抜けた実害）
  const tAscii = t.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  // 英字1単語3文字以上（Unix/PHP/Mysql/Apa等の技術用語）は除外。
  // イニシャル（A.M / K.T / OH）とスペース区切りローマ字（Tanaka Taro）は許容
  if (/^[A-Za-z]{3,}$/.test(tAscii)) return false
  // スキルシートの2文字セクション見出し。イニシャル（OH等）と形が同じため、
  // 実害が確認された語のみ個別除外（OS/DB は 2026-08-08 に人材として登録された）
  if (/^(?:OS|DB|NW)$/i.test(tAscii)) return false
  return true
}

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
      // 氏名列の過半数が駅名 = 最寄駅列を誤って掴んでいる → この見出し行は名簿ではない
      if (dataRows.length >= 2 && isMostlyStationNames(dataRows.map((x) => x.name))) continue
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
        if (isMostlyStationNames(dataRows.map((x) => x.name))) return null
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
    if (isMostlyStationNames(rows.map((r) => r.name))) continue
    const distinctNames = new Set(rows.map(r => r.name.replace(/[.\s　・]/g, '').toLowerCase()))
    if (rows.length >= 2 && distinctNames.size >= 2) return { isRoster: true, rows }
  }
  return { isRoster: false, rows: [] }
}

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

const ROSTER_MAX_ROWS = 70

const ROSTER_LINK_FETCH_BUDGET_MS = 2500

async function expandRosterEntries(entries: SourceEntry[], ledger: Ledger, linkBudgetMs = ROSTER_LINK_FETCH_BUDGET_MS, priorityNames: string[] = []): Promise<SourceEntry[]> {
  const linkFetchStart = Date.now()
  const out: SourceEntry[] = []
  // 本文で紹介されている人材の行を先頭へ（安定ソート）。
  // 行数上限（ROSTER_MAX_ROWS）とリンク取得予算は先頭から消費されるため、並べ替えないと
  // 「本文に名前がある人が名簿の後方行にいる」場合に行情報とリンク先経歴書ごと失われる。
  const normName = (s: string) => s.replace(/[.\s　・]/g, '').toLowerCase()
  const priNorms = priorityNames.map(normName).filter(n => n.length >= 2)
  const isPriority = (rowName: string) => {
    const rn = normName(rowName)
    return rn.length >= 2 && priNorms.some(p => p.includes(rn) || rn.includes(p))
  }
  for (const entry of entries) {
    // 本文で名指しされた人本人の経歴書は名簿判定にかけない（幽霊量産の構造的な防止）
    if (isOwnersResumeFile(entry.filename ?? entry.label ?? '', priorityNames)) {
      ledger.log(entry.entryId, 'C-OWNER-RESUME', `本人の経歴書のため名簿判定せず:${entry.filename ?? entry.label}`)
      out.push(entry)
      continue
    }
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

function promoteUnassignedRosterEntries(
  rosterEntries: SourceEntry[],
  existingBlockNames: (string | null)[],
  ledger: Ledger,
): { name: string; rowText: string }[] {
  const norm = (s: string) => s.replace(/[.\s　・]/g, '').toLowerCase()
  const known = new Set(existingBlockNames.filter((n): n is string => !!n).map(norm))
  const out: { name: string; rowText: string }[] = []
  const perEntry = new Map<string, number>()
  for (const e of rosterEntries) {
    if (!e.rosterRowName) continue
    const n = norm(e.rosterRowName)
    if (n.length < 2 || known.has(n)) continue
    const score = personAttrScore(e.content)
    if (score < 2) {
      ledger.log(e.entryId, 'D-PROMOTE-REJ', `人の属性${score}種のみ:${e.rosterRowName}`)
      continue
    }
    known.add(n)
    ledger.log(e.entryId, 'D-NEWBLOCK', e.rosterRowName)
    // 由来（同一添付/リンク）ごとの生成数。entryId は行ごとに一意なので親IDで束ねる
    const originId = String(e.entryId).replace(/[#:].*$/, '')
    perEntry.set(originId, (perEntry.get(originId) ?? 0) + 1)
    out.push({ name: e.rosterRowName, rowText: e.content })
  }
  // 異常膨張ガード: 1つの添付から上限を超えて人が生まれるのは名簿誤検出の疑いが濃い。
  // 静かに大量登録するより、全件捨てて記録を残す（取りこぼしは再解析で回復できる）
  for (const [originId, count] of perEntry) {
    if (count > MAX_PROMOTED_PER_ENTRY) {
      ledger.log(originId, 'D-PROMOTE-ABORT', `${count}人は異常膨張のため全件却下`)
      console.error(`[roster-anomaly] entry=${originId} が${count}人を生成しようとしたため全件却下`)
      return []
    }
  }
  return out
}

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


export {
  arrayBufferToBase64,
  createLedger,
  filenameFromDisposition,
  detectGoogleLinks,
  fetchCsvFingerprint,
  looksLikeZipBytes,
  fetchSheetsEntry,
  fetchDocsEntry,
  fetchDriveEntry,
  matchSheetByFingerprint,
  extractEntry,
  colIndexFromCellRef,
  looksLikeRosterName,
  detectRoster,
  fetchLinkedResume,
  expandRosterEntries,
  gateSingleCandidate,
  promoteUnassignedRosterEntries,
  pickBodyResumeLink,
  resolveResumeUrl,
  pickSkillYears,
}


export type { SourceEntry, Ledger, Attachment }
