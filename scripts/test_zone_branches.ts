#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * test_zone_branches.ts — ゾーンA〜E/T関数の分岐網羅（C1）テスト
 *
 * 対象: scripts/_zone_functions.gen.ts（index.tsから抽出・sync_zone_functions.mjsで再生成）
 * 方針: 新設パイプラインの全IF分岐を分岐IDで列挙し、合成テストデータで両側を通す。
 *       外部依存（Google fetch・Excel/Word抽出・Storage）は deps にモックを注入。
 *
 * 実行: deno run --allow-read --allow-write scripts/test_zone_branches.ts
 * 出力: コンソールサマリ + scripts/_branch_results.json（HTML項目書生成用）
 */

import {
  deps, createLedger, filenameFromDisposition, detectGoogleLinks, fetchCsvFingerprint,
  fetchSheetsEntry, fetchDocsEntry, fetchDriveEntry, matchSheetByFingerprint, extractEntry,
  looksLikeRosterName, detectRoster, fetchLinkedResume, expandRosterEntries,
  gateSingleCandidate, promoteUnassignedRosterEntries, pickBodyResumeLink,
  resolveResumeUrl, pickSkillYears,
} from './_zone_functions.gen.ts'
import type { SourceEntry } from './_zone_functions.gen.ts'

// ── テストハーネス ──────────────────────────────────────────────────────────
type Row = { id: string; fn: string; branch: string; data: string; ok: boolean; detail: string }
const rows: Row[] = []
function check(id: string, fn: string, branch: string, data: string, cond: boolean, detail = '') {
  rows.push({ id, fn, branch, data, ok: cond, detail })
  if (!cond) console.error(`❌ ${id} ${fn} — ${branch} ${detail}`)
}

const L = () => createLedger('t')
// deno-lint-ignore no-explicit-any
const codes = (led: any, ids: number[] = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]) =>
  JSON.stringify(led.serializeTrace(ids) ?? {})

const resp = (body: BodyInit | null, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers })

/** URLパターン→レスポンス生成のルーター。マッチしなければ例外（=ネットワーク失敗扱い） */
function route(routes: Array<[RegExp, () => Response]>) {
  deps.fetchWithTimeout = (url: string) => {
    for (const [re, fn] of routes) if (re.test(url)) return Promise.resolve(fn())
    return Promise.reject(new Error(`unrouted: ${url}`))
  }
}

function resetDeps() {
  deps.fetchWithTimeout = () => Promise.reject(new Error('fetch未モック'))
  deps.extractSkillYearsFromSheetData = () => ({})
  deps.extractNameFallback = (seg: string) => {
    if (seg.includes('NONAME')) return null
    const m = seg.match(/【氏名】[：:]?\s*([^\n※【]+)/) ?? seg.match(/氏名[：:]\s*([^\n※]+)/) ?? seg.match(/■([A-Z]{1,4})（/)
    return m ? m[1].trim() : null
  }
  deps.cleanseWordText = (t: string) => t.trim()
  deps.uploadToStorage = () => Promise.resolve(null)
  deps.extractExcelAll = () => Promise.resolve({ text: '', skillYears: {} })
  deps.extractWordText = () => Promise.resolve({ text: '' })
  deps.extractPdfText = () => Promise.resolve('')
}

const e = (over: Partial<SourceEntry>): SourceEntry => ({
  entryId: over.entryId ?? 1, label: 'テスト', content: '', filename: 'test.xlsx',
  kind: 'excel', origin: 'attachment', ...over,
})

// ═══ ゾーンT: createLedger / serializeTrace ═══════════════════════════════
{
  resetDeps()
  { const l = L(); check('T-01', 'serializeTrace', 'ログ0件+違反0件 → undefined', 'log/violate呼び出しなし',
      l.serializeTrace([]) === undefined) }
  { const l = L(); l.log(1, 'A-XLSX-OK'); l.log(null, 'E-URL-NONE'); l.log(1, 'B-EXTRACT-OK', 'detail文字列')
    const t = l.serializeTrace([1]) as Record<string, unknown>
    const s = JSON.stringify(t)
    check('T-02', 'serializeTrace', '通常サイズ → assigned/summary/emailCodes/violations', 'entryログ2+emailログ1',
      s.includes('A-XLSX-OK') && s.includes('B-EXTRACT-OK(detail文字列)') && s.includes('E-URL-NONE')
      && (t.invariantViolations as string[]).length === 0) }
  { const l = L(); l.violate('INV-D-DUP', 'x'.repeat(200))
    check('T-03', 'violate', 'detailが120字に切り詰められる', '200字detail',
      l.invariantViolations[0].length <= 'INV-D-DUP()'.length + 120) }
  { const l = L(); for (let i = 0; i < 600; i++) l.log(null, 'A-FETCH-FAIL', 'd'.repeat(60))
    const t = l.serializeTrace([]) as Record<string, unknown>
    check('T-04', 'serializeTrace', '8KB超 → emailCodes末尾40件のcompactへ縮退（truncated:true）', 'emailログ600件',
      t.truncated === true && (t.emailCodes as string[]).length === 40) }
  { const l = L(); for (let i = 1; i <= 400; i++) l.log(i, 'B-EXTRACT-OK', 'd'.repeat(60))
    const t = l.serializeTrace([]) as Record<string, unknown>
    check('T-05', 'serializeTrace', 'compactも8KB超 → violationsのみの最終縮退', 'entryログ400件（summary肥大）',
      t.truncated === true && !('summary' in t)) }
}

// ═══ ゾーンA: filenameFromDisposition ══════════════════════════════════════
{
  const r1 = resp(null, 200, { 'content-disposition': 'attachment; filename="resume.xlsx"' })
  check('FD-01', 'filenameFromDisposition', 'filename="..." → ファイル名', 'attachment; filename="resume.xlsx"',
    filenameFromDisposition(r1) === 'resume.xlsx')
  const r2 = resp(null, 200, { 'content-disposition': "attachment; filename*=UTF-8''%E7%B5%8C%E6%AD%B4.xlsx" })
  check('FD-02', 'filenameFromDisposition', "filename*=UTF-8'' → URLデコード", '%E7%B5%8C%E6%AD%B4.xlsx',
    filenameFromDisposition(r2) === '経歴.xlsx')
  check('FD-03', 'filenameFromDisposition', 'ヘッダなし → null', 'content-dispositionなし',
    filenameFromDisposition(resp(null)) === null)
  const r4 = resp(null, 200, { 'content-disposition': 'attachment; filename=100%zzz.pdf' })
  check('FD-04', 'filenameFromDisposition', 'デコード失敗（不正%） → 生の値', 'filename=100%zzz.pdf',
    filenameFromDisposition(r4) === '100%zzz.pdf')
  // Google Driveが生UTF-8バイトをヘッダに載せるケース（latin1化け→再デコード）。実リンク検証で発見
  const mojibake = [...new TextEncoder().encode('経歴書_TS.pdf')].map(b => String.fromCharCode(b)).join('')
  const r5 = resp(null, 200, { 'content-disposition': `attachment; filename="${mojibake}"` })
  check('FD-05', 'filenameFromDisposition', '生UTF-8バイトの文字化け → 再デコードで日本語復元', 'latin1化けした「経歴書_TS.pdf」',
    filenameFromDisposition(r5) === '経歴書_TS.pdf')
  check('FD-06', 'filenameFromDisposition', '化けていない通常名は再デコードしない', 'plain.pdf',
    filenameFromDisposition(resp(null, 200, { 'content-disposition': 'attachment; filename="plain.pdf"' })) === 'plain.pdf')
}

// ═══ ゾーンA: detectGoogleLinks ════════════════════════════════════════════
{
  const id1 = 'A'.repeat(30), id2 = 'B'.repeat(30), id3 = 'C'.repeat(30)
  { const r = detectGoogleLinks(`https://docs.google.com/spreadsheets/d/${id1}/edit#gid=5`)
    check('GL-01', 'detectGoogleLinks', 'Sheets + #gid= → gid抽出', '#gid=5',
      r.sheets.length === 1 && r.sheets[0].gid === '5') }
  { const r = detectGoogleLinks(`https://docs.google.com/spreadsheets/d/${id1}/export?gid=7&x=1`)
    check('GL-02', 'detectGoogleLinks', 'Sheets + ?gid= → gid抽出', '?gid=7',
      r.sheets[0].gid === '7') }
  { const r = detectGoogleLinks(`https://docs.google.com/spreadsheets/d/${id1}/edit`)
    check('GL-03', 'detectGoogleLinks', 'gidなし → 既定 0', 'gid指定なし',
      r.sheets[0].gid === '0') }
  { const r = detectGoogleLinks(`x https://docs.google.com/spreadsheets/d/${id1}/edit y https://docs.google.com/spreadsheets/d/${id1}/edit#gid=9`)
    check('GL-04', 'detectGoogleLinks', '同一SheetsのID重複 → 1件（初出優先）', '同一ID×2',
      r.sheets.length === 1 && r.sheets[0].gid === '0') }
  { const r = detectGoogleLinks(`https://docs.google.com/document/d/${id2}/edit https://docs.google.com/document/d/${id2}/`)
    check('GL-05', 'detectGoogleLinks', 'Docs検出 + ID重複排除', 'Docs同一ID×2',
      r.docs.length === 1 && r.docs[0].id === id2) }
  { const r = detectGoogleLinks(`https://drive.google.com/file/d/${id3}/view https://drive.google.com/open?id=${id3}`)
    check('GL-06', 'detectGoogleLinks', 'Drive file/d/ と open?id= 両形式 + 重複排除', 'Drive 2形式×同一ID',
      r.drive.length === 1) }
  { const r = detectGoogleLinks('リンクを含まない本文です')
    check('GL-07', 'detectGoogleLinks', 'リンクなし → 全て空', 'Google URLなし',
      r.sheets.length === 0 && r.docs.length === 0 && r.drive.length === 0) }
}

// ═══ ゾーンA: fetchCsvFingerprint ══════════════════════════════════════════
{
  resetDeps()
  route([[/format=csv/, () => resp('"a,b",c\nd,e')]])
  const r = await fetchCsvFingerprint('ID', '0')
  check('CF-01', 'fetchCsvFingerprint', '取得成功 + クォート内カンマの保持', '"a,b",c / d,e',
    r !== null && r.rows[0][0] === 'a,b' && r.rows[0][1] === 'c' && r.rows[1][0] === 'd')
  route([[/format=csv/, () => resp(',"シメイ\n氏　名",\n,,x')]])
  { const r = await fetchCsvFingerprint('ID', '0')
    check('CF-04', 'fetchCsvFingerprint', '引用符内の改行 → 1セルとして保持（gid照合を壊さない）', '"シメイ\\n氏　名" 複数行セル',
      r !== null && r.rows[0][1] === 'シメイ\n氏　名' && r.rows.length === 2) }
  route([[/format=csv/, () => resp('"He said ""hi""",b')]])
  { const r = await fetchCsvFingerprint('ID', '0')
    check('CF-05', 'fetchCsvFingerprint', '""エスケープ → 引用符1個に復元', '"He said ""hi"""',
      r !== null && r.rows[0][0] === 'He said "hi"') }
  route([[/format=csv/, () => resp('x', 403)]])
  check('CF-02', 'fetchCsvFingerprint', 'HTTPエラー → null', 'status 403',
    (await fetchCsvFingerprint('ID', '0')) === null)
  deps.fetchWithTimeout = () => Promise.reject(new Error('net'))
  check('CF-03', 'fetchCsvFingerprint', 'fetch例外 → null', 'ネットワーク例外',
    (await fetchCsvFingerprint('ID', '0')) === null)
}

// ═══ ゾーンA: fetchSheetsEntry ═════════════════════════════════════════════
{
  const ID = 'S'.repeat(30)
  resetDeps()
  route([
    [/format=csv/, () => resp('氏名,年齢\n山田,30')],
    [/format=xlsx/, () => resp(new Uint8Array([1, 2, 3]), 200, { 'content-disposition': 'attachment; filename="skill.xlsx"' })],
  ])
  { const l = L(); const r = await fetchSheetsEntry({ id: ID, gid: '2' }, l)
    check('FS-01', 'fetchSheetsEntry', 'XLSX成功 → bytes+gidHint（CSVフィンガープリント併載）', 'xlsx 200 + csv 200',
      r?.kind === 'excel' && !!r?.attachment?.data && r?.gidHint?.gid === '2'
      && r?.gidHint?.csvRows?.[0][0] === '氏名' && codes(l).includes('A-XLSX-OK')) }
  route([
    [/format=csv/, () => resp('氏名,年齢\n山田,30')],
    [/format=xlsx/, () => resp('err', 500)],
  ])
  { const l = L(); const r = await fetchSheetsEntry({ id: ID, gid: '0' }, l)
    check('FS-02', 'fetchSheetsEntry', 'XLSX失敗(HTTP) → CSV保険にフォールバック', 'xlsx 500 + csv 200',
      r?.kind === 'text' && r.content.includes('山田') && codes(l).includes('A-FETCH-FAIL') && codes(l).includes('A-CSV-FB')) }
  { deps.extractSkillYearsFromSheetData = () => ({ Java: 12 })
    const l = L(); const r = await fetchSheetsEntry({ id: ID, gid: '0' }, l)
    check('FS-03', 'fetchSheetsEntry', 'CSV保険 + skillYears非空 → skillYears設定', 'skill抽出が{Java:12}を返す',
      r?.skillYears?.Java === 12)
    deps.extractSkillYearsFromSheetData = () => ({}) }
  route([
    [/format=csv/, () => resp('中身あり')],
    [/format=xlsx/, () => { throw new Error('timeout') }],
  ])
  { const l = L(); const r = await fetchSheetsEntry({ id: ID, gid: '0' }, l)
    check('FS-04', 'fetchSheetsEntry', 'XLSX例外(タイムアウト) → CSV保険', 'xlsx throw + csv 200',
      r?.kind === 'text' && codes(l).includes('A-CSV-FB')) }
  route([
    [/format=csv/, () => resp('x', 500)],
    [/format=xlsx/, () => resp('x', 500)],
  ])
  { const l = L(); check('FS-05', 'fetchSheetsEntry', 'XLSXもCSVも失敗 → null', '両方 500',
      (await fetchSheetsEntry({ id: ID, gid: '0' }, l)) === null) }
  route([
    [/format=csv/, () => resp('   ')],
    [/format=xlsx/, () => resp('x', 500)],
  ])
  { const l = L(); check('FS-06', 'fetchSheetsEntry', 'CSVが空白のみ → 保険にせず null', 'csv=空白',
      (await fetchSheetsEntry({ id: ID, gid: '0' }, l)) === null) }
  route([
    [/format=csv/, () => resp('a,b')],
    [/format=xlsx/, () => resp(new Uint8Array([1]), 200, { 'content-disposition': 'attachment; filename="SheetTitle"' })],
  ])
  { const l = L(); const r = await fetchSheetsEntry({ id: ID, gid: '0' }, l)
    check('FS-07', 'fetchSheetsEntry', '拡張子なしdisposition → attachment.name に .xlsx 付与', 'filename="SheetTitle"（拡張子なし）',
      r?.attachment?.name === 'SheetTitle.xlsx') }
}

// ═══ ゾーンA: fetchDocsEntry ═══════════════════════════════════════════════
{
  const ID = 'D'.repeat(30)
  resetDeps()
  route([[/format=docx/, () => resp(new Uint8Array([1]), 200, { 'content-disposition': 'attachment; filename="resume.docx"' })]])
  { const l = L(); const r = await fetchDocsEntry({ id: ID }, l)
    check('FDx-01', 'fetchDocsEntry', 'DOCX成功 → bytes保持', 'docx 200',
      r?.kind === 'word' && !!r?.attachment?.data && codes(l).includes('A-DOCX-OK')) }
  route([
    [/format=docx/, () => resp('x', 500)],
    [/format=txt/, () => resp('本文テキスト')],
  ])
  { const l = L(); const r = await fetchDocsEntry({ id: ID }, l)
    check('FDx-02', 'fetchDocsEntry', 'DOCX失敗 → txt保険', 'docx 500 + txt 200',
      r?.kind === 'text' && r.content === '本文テキスト' && codes(l).includes('A-TXT-FB')) }
  route([
    [/format=docx/, () => { throw new Error('net') }],
    [/format=txt/, () => resp('x', 404)],
  ])
  { const l = L(); check('FDx-03', 'fetchDocsEntry', 'DOCX例外 + txt HTTPエラー → null', 'docx throw + txt 404',
      (await fetchDocsEntry({ id: ID }, l)) === null) }
  route([
    [/format=docx/, () => resp('x', 500)],
    [/format=txt/, () => { throw new Error('net') }],
  ])
  { const l = L(); check('FDx-04', 'fetchDocsEntry', 'txt側も例外 → null', 'docx 500 + txt throw',
      (await fetchDocsEntry({ id: ID }, l)) === null) }
}

// ═══ ゾーンA: fetchDriveEntry ══════════════════════════════════════════════
{
  const ID = 'X'.repeat(30)
  resetDeps()
  { const body = `ポートフォリオはこちら https://drive.google.com/file/d/${ID}/view`
    const l = L(); const r = await fetchDriveEntry({ id: ID, index: body.indexOf('https://') }, body, l)
    check('DR-01', 'fetchDriveEntry', '直前150字にポートフォリオ語 → スキップ', 'ポートフォリオ+リンク',
      r === null && codes(l).includes('A-SKIP-PORTFOLIO')) }
  route([[/uc\?export=download/, () => resp('x', 403)]])
  { const l = L(); check('DR-02', 'fetchDriveEntry', 'HTTPエラー → null', 'status 403',
      (await fetchDriveEntry({ id: ID, index: 0 }, '', l)) === null) }
  route([[/uc\?export=download/, () => resp(new Uint8Array([1]), 200, { 'content-type': 'application/pdf' })]])
  { const l = L(); const r = await fetchDriveEntry({ id: ID, index: 0 }, '', l)
    check('DR-03', 'fetchDriveEntry', 'content-type=pdf → kind=pdf + bytes', 'application/pdf',
      r?.kind === 'pdf' && !!r?.attachment?.data) }
  route([[/uc\?export=download/, () => resp('プレーンテキスト経歴', 200, { 'content-type': 'text/plain; charset=utf-8' })]])
  { const l = L(); const r = await fetchDriveEntry({ id: ID, index: 0 }, '', l)
    check('DR-04', 'fetchDriveEntry', 'content-type=text → kind=text（本文読込）', 'text/plain',
      r?.kind === 'text' && r.content.includes('プレーン')) }
  route([[/uc\?export=download/, () => resp(new Uint8Array([1]), 200, { 'content-type': 'application/vnd.ms-excel' })]])
  { const l = L(); const r = await fetchDriveEntry({ id: ID, index: 0 }, '', l)
    check('DR-05', 'fetchDriveEntry', 'Excel系MIME → kind=excel', 'application/vnd.ms-excel',
      r?.kind === 'excel') }
  route([[/uc\?export=download/, () => resp(new Uint8Array([1]), 200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="resume.docx"' })]])
  { const l = L(); const r = await fetchDriveEntry({ id: ID, index: 0 }, '', l)
    check('DR-06', 'fetchDriveEntry', 'MIME不明でも拡張子.docx → kind=word', 'octet-stream + resume.docx',
      r?.kind === 'word') }
  route([[/uc\?export=download/, () => resp(new Uint8Array([1]), 200, { 'content-type': 'image/png' })]])
  { const l = L(); const r = await fetchDriveEntry({ id: ID, index: 0 }, '', l)
    check('DR-07', 'fetchDriveEntry', '未対応タイプ → null + 診断ログ', 'image/png',
      r === null && codes(l).includes('未対応タイプ')) }
  deps.fetchWithTimeout = () => Promise.reject(new Error('net'))
  { const l = L(); check('DR-08', 'fetchDriveEntry', 'fetch例外 → null', 'ネットワーク例外',
      (await fetchDriveEntry({ id: ID, index: 0 }, '', l)) === null) }
}

// ═══ ゾーンB: matchSheetByFingerprint ══════════════════════════════════════
{
  check('MF-01', 'matchSheetByFingerprint', '有効セル3個未満 → null（照合不能）', 'CSV=1セルのみ',
    matchSheetByFingerprint([{ name: 'A', head: [['スキル', '年数']] }], [['スキル']]) === null)
  const csv = [['スキル', '経験年数', '氏名', '最寄駅', '単価']]
  check('MF-02', 'matchSheetByFingerprint', '8割以上一致 → シート名', '5セル中5一致',
    matchSheetByFingerprint([{ name: '対象', head: [['スキル', '経験年数', '氏名', '最寄駅', '単価']] }], csv) === '対象')
  check('MF-03', 'matchSheetByFingerprint', '最高スコアでも8割未満 → null（誤爆防止）', '5セル中3一致',
    matchSheetByFingerprint([{ name: 'A', head: [['スキル', '経験年数', '氏名', '無関係1', '無関係2']] }], csv) === null)
  check('MF-04', 'matchSheetByFingerprint', '複数シート → 最良一致を選択', '一致2個 vs 5個',
    matchSheetByFingerprint([
      { name: '弱', head: [['スキル', '経験年数']] },
      { name: '強', head: [['スキル', '経験年数', '氏名', '最寄駅', '単価']] },
    ], csv) === '強')
}

// ═══ ゾーンB: extractEntry ═════════════════════════════════════════════════
{
  resetDeps()
  { const src = e({ content: '元テキスト' }); const l = L()
    check('EE-01', 'extractEntry', 'bytesなし（text系） → そのまま返す', 'attachmentなし',
      (await extractEntry(src, l)) === src) }
  { deps.extractExcelAll = () => Promise.resolve({ text: '', skillYears: {}, parseError: 'zip壊れ' })
    const l = L(); await extractEntry(e({ attachment: { data: 'AA', mimeType: 'x' } }), l)
    check('EE-02', 'extractEntry', 'Excel parseError → B-PARSE-ERR記録', 'parseError=zip壊れ',
      codes(l).includes('B-PARSE-ERR')) }
  { deps.extractExcelAll = () => Promise.resolve({ text: '抽出成功', skillYears: { Java: 24 }, links: [{ cell: 'A1', url: 'https://x' }], sheetPickedBy: 'gid', jsonRows: [{ a: '1' }] })
    const l = L(); const r = await extractEntry(e({ attachment: { data: 'AA', mimeType: 'x' }, gidHint: { gid: '2' } }), l)
    check('EE-03', 'extractEntry', 'Excel成功 + gid選択 + リンクあり → B-SHEET-GID/B-LINKS/内容反映', 'gidCsvRowsあり',
      r.content === '抽出成功' && r.skillYears?.Java === 24 && codes(l).includes('B-SHEET-GID') && codes(l).includes('B-LINKS')) }
  { deps.extractExcelAll = () => Promise.resolve({ text: 'テキストのみ', skillYears: {} })
    const l = L(); const r = await extractEntry(e({ attachment: { data: 'AA', mimeType: 'x' } }), l)
    check('EE-04', 'extractEntry', 'Excel skillYears空 → undefined（空オブジェクトを残さない）', 'skillYears={}',
      r.skillYears === undefined && codes(l).includes('B-EXTRACT-OK')) }
  { deps.extractWordText = () => Promise.resolve({ text: '   ' })
    const l = L(); const r = await extractEntry(e({ kind: 'word', attachment: { data: 'AA', mimeType: 'x' } }), l)
    check('EE-05', 'extractEntry', 'Word抽出結果が空 → B-EXTRACT-EMPTY', 'text=空白のみ',
      r.content === '' && codes(l).includes('B-EXTRACT-EMPTY')) }
  { deps.extractWordText = () => Promise.resolve({ text: 'Word本文', totalProjectMonths: 36, links: [{ cell: 'a1', url: 'https://x' }] })
    const l = L(); const r = await extractEntry(e({ kind: 'word', attachment: { data: 'AA', mimeType: 'x' } }), l)
    check('EE-06', 'extractEntry', 'Word成功 + links + 月数 → 反映', 'links1件+月数36',
      r.totalProjectMonths === 36 && codes(l).includes('B-LINKS')) }
  { deps.extractPdfText = () => Promise.resolve('PDF本文')
    const l = L(); const r = await extractEntry(e({ kind: 'pdf', attachment: { data: 'AA', mimeType: 'x' } }), l)
    check('EE-07', 'extractEntry', 'PDF → テキスト抽出', 'pdf text=PDF本文',
      r.content === 'PDF本文') }
  { const src = e({ kind: 'text', attachment: { data: 'AA', mimeType: 'x' }, content: 'raw' })
    const l = L()
    check('EE-08', 'extractEntry', 'kind=text（どの分岐にも該当せず） → そのまま', 'bytesありkind=text',
      (await extractEntry(src, l)) === src) }
}

// ═══ ゾーンC: looksLikeRosterName ══════════════════════════════════════════
{
  const T = (v: string) => looksLikeRosterName(v)
  check('LN-01', 'looksLikeRosterName', '空文字 → false', '""', !T(''))
  check('LN-02', 'looksLikeRosterName', '26字超 → false', '26字の文字列', !T('あ'.repeat(26)))
  check('LN-03', 'looksLikeRosterName', '経歴書ラベル語 → false', '生年月日/最終学歴/作業概要',
    !T('生年月日') && !T('最終学歴') && !T('作業概要') && !T('期間') && !T('要件定義'))
  check('LN-04', 'looksLikeRosterName', '数字・括弧始まり → false', '1989年4月 / （参考）',
    !T('1989年4月') && !T('（参考）'))
  check('LN-05', 'looksLikeRosterName', '英字1単語3字以上（技術用語） → false', 'Unix/Mysql/Apa',
    !T('Unix') && !T('Mysql') && !T('Apa'))
  check('LN-06', 'looksLikeRosterName', 'イニシャル → true', 'A.M / OH / K.T',
    T('A.M') && T('OH') && T('K.T'))
  check('LN-07', 'looksLikeRosterName', '漢字姓名・スペース区切りローマ字 → true', '山田 太郎 / Tanaka Taro',
    T('山田 太郎') && T('Tanaka Taro'))
}

// ═══ ゾーンC: detectRoster（グリッド型） ═══════════════════════════════════
{
  resetDeps()
  const header = ['氏名', '年齢', '最寄駅', 'スキルシート']
  { const r = detectRoster(e({ grid: undefined, content: '本文のみ' }))
    check('DG-01', 'detectRoster', 'gridなし → グリッド判定スキップ（非名簿）', 'grid=undefined', !r.isRoster) }
  { const r = detectRoster(e({ grid: [['スキル', '年数'], ['Java', '5'], ['AWS', '3']], content: '' }))
    check('DG-02', 'detectRoster', '氏名ヘッダ列なし → 非名簿', 'ヘッダ=スキル/年数', !r.isRoster) }
  { const r = detectRoster(e({ grid: [['フリガナ', '氏名', 'ヤマダ'], ['', '山田 太郎', ''], ['', '佐藤 花子', 'x']], content: '' }))
    check('DG-03', 'detectRoster', '氏名セルはあるがヘッダ語（年齢/駅/単価等）が同行にない → 非名簿（縦型経歴書対策）', '氏名の行にヘッダ語なし',
      !r.isRoster) }
  { const grid = [header, ['山田 太郎', '30', '渋谷', 'リンク'], ['佐藤 花子', '40', '横浜', 'リンク']]
    const links = [{ cell: 'D2', url: 'https://drive.google.com/file/d/' + 'L'.repeat(30) }, { cell: 'D3', url: 'https://x.example/y' }]
    const r = detectRoster(e({ grid, links, content: '' }))
    check('DG-04', 'detectRoster', '正常な名簿（ヘッダ+人名2行） → 名簿・行リンク対応付け', '2人+行リンク',
      r.isRoster && r.rows.length === 2 && r.rows[0].name === '山田 太郎'
      && r.rows[0].links.length === 1 && r.rows[0].links[0].cell === 'D2' && r.rows[1].links[0].cell === 'D3') }
  { const grid = [header, ['山田 太郎', '30', '渋谷', ''], ['佐藤 花子', '40', '横浜', ''],
      ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['遠藤 離れ', '50', '大宮', '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DG-05', 'detectRoster', '空行3行で表終了 → 離れたセルを行として拾わない', '2人+空行3+遠隔1人',
      r.isRoster && r.rows.length === 2) }
  { const grid = [header, ['こ'.repeat(31), '30', '渋谷', ''], ['山田 太郎', '30', '渋谷', ''], ['佐藤 花子', '40', '横浜', '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DG-06', 'detectRoster', '30字超の氏名セルはスキップ', '31字の値+正常2人',
      r.isRoster && r.rows.length === 2) }
  { const grid = [header, ['生年月日', '30', '渋谷', ''], ['山田 太郎', '30', '渋谷', ''], ['佐藤 花子', '40', '横浜', '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DG-07', 'detectRoster', 'ラベル語の氏名セルはスキップ（looksLikeRosterName連携）', '生年月日+正常2人',
      r.isRoster && r.rows.length === 2 && r.rows.every(x => x.name !== '生年月日')) }
  { const grid = [header, ['山田 太郎', '', '', ''], ['佐藤 花子', '40', '横浜', '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DG-08', 'detectRoster', '氏名以外が1セル以下の行はスキップ（人材行でない）', '他セル0個の行',
      !r.isRoster || r.rows.length < 2) }
  { const grid = [header, ['山田 太郎', '30', '渋谷', '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DG-09', 'detectRoster', '人材行1行のみ → 非名簿（1人用プロフィール表）', '1人だけ', !r.isRoster) }
}

// ═══ ゾーンC: detectRoster（グリッド型②: サマリー列名簿） ═════════════════
{
  resetDeps()
  const summary = (name: string, sta: string) => `【氏名】：${name}\n【年齢】：45歳\n【性別】：男性\n【最寄】：${sta}\n【スキル】：Java、AWS`
  const header = ['メインスキル', '開始', '単価', 'サマリー', 'スキルシート']
  { const grid = [header,
      ['Java', '7月', '85万', summary('I.S', '上総一ノ宮駅'), 'リンク'],
      ['PHP', '8月', '70万', summary('F.K', '都賀駅'), 'リンク']]
    const links = [{ cell: 'E2', url: 'https://docs.google.com/spreadsheets/d/' + 'Z'.repeat(30) }, { cell: 'E3', url: 'https://docs.google.com/document/d/' + 'Z'.repeat(30) }]
    const r = detectRoster(e({ grid, links, content: '' }))
    check('DS-01', 'detectRoster', 'サマリー列名簿（氏名ヘッダ列なし・【氏名】入りセル縦並び） → 名簿・行リンク対応付け', 'アイスタンダード形式2人+リンク',
      r.isRoster && r.rows.length === 2 && r.rows[0].name === 'I.S' && r.rows[1].name === 'F.K'
      && r.rows[0].links[0]?.cell === 'E2' && r.rows[1].links[0]?.cell === 'E3'
      && r.rows[0].rowText.includes('【メインスキル】Java') && r.rows[0].rowText.includes('【氏名】：I.S')) }
  { const grid = [header, ['Java', '7月', '85万', summary('I.S', '上総一ノ宮駅'), '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DS-02', 'detectRoster', 'サマリーセルが1個のみ → 非名簿', '1人だけの一覧', !r.isRoster) }
  { const grid = [header,
      ['Java', '7月', '85万', summary('I.S', '上総一ノ宮駅'), ''],
      ['PHP', '8月', '70万', summary('I.S', '都賀駅'), '']]
    const r = detectRoster(e({ grid, content: '' }))
    check('DS-03', 'detectRoster', 'サマリー列の氏名が同一人物のみ → 非名簿', '同名I.S×2行', !r.isRoster) }
  { const grid = [['自由記述メモ'], [summary('I.S', 'A駅')], [summary('F.K', 'B駅')]]
    const r = detectRoster(e({ grid, content: '' }))
    check('DS-04', 'detectRoster', 'ヘッダ行なしでも検出（ラベルなし行テキスト）', 'ヘッダなし2人',
      r.isRoster && r.rows.length === 2 && !r.rows[0].rowText.includes('【自由記述メモ】')) }
}

// ═══ ゾーンC: detectRoster（テキスト型） ═══════════════════════════════════
{
  resetDeps()
  const person = (name: string) => `【氏名】${name}\n【年齢】30歳\n【最寄駅】渋谷駅\n【スキル】Java、AWS、Docker一式`
  { const c = `--- シート: 履歴書 ---\n${person('山田 太郎')}\n--- シート: 経歴書 ---\n${person('山田 太郎')}`
    const r = detectRoster(e({ content: c }))
    check('DT-01', 'detectRoster', 'シート跨ぎの氏名2出現 → 非名簿（同一人物の重複登録防止）', '履歴書+経歴書の各1名',
      !r.isRoster) }
  { const c = `--- シート: 一覧 ---\n${person('山田 太郎')}\n${person('佐藤 花子')}`
    const r = detectRoster(e({ content: c }))
    check('DT-02', 'detectRoster', '同一シート内に氏名2セット → 名簿', '1シートに2名',
      r.isRoster && r.rows.length === 2 && r.rows[1].name === '佐藤 花子') }
  { const c = `【氏名】山\n【氏名】田`
    const r = detectRoster(e({ content: c }))
    check('DT-03', 'detectRoster', 'セグメント30字未満 → 行として不採用', '極小セグメント×2', !r.isRoster) }
  { const c = `■KT（28歳／男性）ですがフィールドラベルを一切含まない自由文が続きます云々かんぬん\n■MW（30歳／男性）こちらも同様にラベルなしの自由文が続くだけの段落です云々かんぬん`
    const r = detectRoster(e({ content: c }))
    check('DT-04', 'detectRoster', '候補者フィールド語を含まないセグメント → 不採用', '■XX（歳）形式+ラベルなし', !r.isRoster) }
  { const c = `【氏名】NONAME\n【年齢】30歳\n【最寄駅】渋谷駅でセグメント長確保\n【氏名】NONAME\n【年齢】40歳\n【最寄駅】横浜駅でセグメント長確保`
    const r = detectRoster(e({ content: c }))
    check('DT-05', 'detectRoster', '氏名抽出がnull → 行として不採用', 'extractNameFallback=null', !r.isRoster) }
  { const r = detectRoster(e({ content: `${person('山田 太郎')}だけ` }))
    check('DT-06', 'detectRoster', '氏名1セットのみ → 非名簿', '1名分のテキスト', !r.isRoster) }
  { const c = `${person('山田 太郎')}\n${person('山田太郎')}`
    const r = detectRoster(e({ content: c }))
    check('DT-07', 'detectRoster', '同一人物の氏名2回（表紙+本文等） → 非名簿（相異なる氏名2人以上が条件）', '同名（表記ゆれ）×2セット',
      !r.isRoster) }
}

// ═══ ゾーンC: fetchLinkedResume ════════════════════════════════════════════
{
  resetDeps()
  { const l = L(); const r = await fetchLinkedResume('https://docs.google.com/spreadsheets/d/' + 'Q'.repeat(30), l, 1)
    check('FL-01', 'fetchLinkedResume', 'depth>=1 → 打ち切り（名簿の名簿は展開しない）', 'depth=1',
      r === null && codes(l).includes('C-DEPTH-CUT')) }
  { route([
      [/format=csv/, () => resp('a,b')],
      [/format=xlsx/, () => resp(new Uint8Array([1]), 200)],
    ])
    deps.extractExcelAll = () => Promise.resolve({ text: 'リンク先の経歴', skillYears: {} })
    const l = L(); const r = await fetchLinkedResume('https://docs.google.com/spreadsheets/d/' + 'Q'.repeat(30) + '/edit', l, 0)
    check('FL-02', 'fetchLinkedResume', 'Sheetsリンク → 取得+抽出', 'sheets URL', r?.content === 'リンク先の経歴') }
  { route([[/format=docx/, () => resp(new Uint8Array([1]), 200)]])
    deps.extractWordText = () => Promise.resolve({ text: 'Word経歴' })
    const l = L(); const r = await fetchLinkedResume('https://docs.google.com/document/d/' + 'Q'.repeat(30), l, 0)
    check('FL-03', 'fetchLinkedResume', 'Docsリンク → 取得+抽出', 'docs URL', r?.content === 'Word経歴') }
  { route([[/uc\?export=download/, () => resp(new Uint8Array([1]), 200, { 'content-type': 'application/pdf' })]])
    deps.extractPdfText = () => Promise.resolve('PDF経歴')
    const l = L(); const r = await fetchLinkedResume('https://drive.google.com/file/d/' + 'Q'.repeat(30) + '/view', l, 0)
    check('FL-04', 'fetchLinkedResume', 'Driveリンク → 取得+抽出', 'drive URL', r?.content === 'PDF経歴') }
  { const l = L(); check('FL-05', 'fetchLinkedResume', 'Google系でないURL → null', 'https://example.com/x',
      (await fetchLinkedResume('https://example.com/x', l, 0)) === null) }
  { route([[/./, () => resp('x', 500)]])
    const l = L(); check('FL-06', 'fetchLinkedResume', '取得失敗 → null', '全route 500',
      (await fetchLinkedResume('https://docs.google.com/document/d/' + 'Q'.repeat(30), l, 0)) === null) }
}

// ═══ ゾーンC: expandRosterEntries ══════════════════════════════════════════
{
  resetDeps()
  const header = ['氏名', '年齢', '最寄駅', 'スキルシート']
  { const src = e({ content: '普通の経歴書テキスト' })
    const l = L(); const r = await expandRosterEntries([src], l)
    check('ER-01', 'expandRosterEntries', '非名簿エントリ → そのまま素通し', '名簿でない1件',
      r.length === 1 && r[0] === src) }
  { const grid = [header, ['山田 太郎', '30', '渋谷', ''], ['佐藤 花子', '40', '横浜', 'https://example.com/資料']]
    const links = [{ cell: 'D3', url: 'https://box.com/s/abc' }]
    const l = L(); const r = await expandRosterEntries([e({ grid, links, content: '' })], l)
    check('ER-02', 'expandRosterEntries', '埋め込み型行 → 行テキストで単票化（非Googleリンクは本文に残す）', '2人・Boxリンク1個',
      r.length === 2 && r[0].rosterRowName === '山田 太郎' && r[0].parentId === 1
      && r[1].content.includes('https://box.com/s/abc') && codes(l).includes('C-ROW-EMBED')) }
  { const grid = [header, ...Array.from({ length: 20 }, (_, i) => [`社員${i}山田`, '30', '渋谷', ''])]
    const l = L(); const r = await expandRosterEntries([e({ grid, content: '' })], l)
    check('ER-03', 'expandRosterEntries', '行数上限（15行）で打ち切り + C-ROSTER-CAP', '20人の名簿',
      r.length === 15 && codes(l).includes('C-ROSTER-CAP')) }
  { const grid = [header, ['山田 太郎', '30', '渋谷', 'リンク'], ['佐藤 花子', '40', '横浜', '']]
    const links = [{ cell: 'D2', url: 'https://docs.google.com/spreadsheets/d/' + 'R'.repeat(30) + '/edit' }]
    route([
      [/format=csv/, () => resp('a,b')],
      [/format=xlsx/, () => resp(new Uint8Array([1]), 200)],
    ])
    deps.extractExcelAll = () => Promise.resolve({ text: '山田さんの個人経歴シート', skillYears: { Java: 60 } })
    const l = L(); const r = await expandRosterEntries([e({ grid, links, content: '' })], l)
    check('ER-04', 'expandRosterEntries', 'Googleリンク行 → リンク先を取得し本人エントリに差し替え', '行リンク=Sheets',
      r.length === 2 && r[0].content.includes('山田さんの個人経歴シート') && r[0].content.includes('【氏名】山田 太郎')
      && r[0].skillYears?.Java === 60 && r[0].rosterRowName === '山田 太郎' && codes(l).includes('C-ROW-LINK-OK')) }
  { const grid = [header, ['山田 太郎', '30', '渋谷', 'リンク'], ['佐藤 花子', '40', '横浜', '']]
    const links = [{ cell: 'D2', url: 'https://docs.google.com/spreadsheets/d/' + 'R'.repeat(30) + '/edit' }]
    route([[/./, () => resp('x', 500)]])
    const l = L(); const r = await expandRosterEntries([e({ grid, links, content: '' })], l)
    check('ER-05', 'expandRosterEntries', 'リンク取得失敗 → 行テキストの埋め込みで継続（C-ROW-LINK-FAIL）', '行リンク先が全滅',
      r.length === 2 && r[0].content.includes('【氏名】山田 太郎') && codes(l).includes('C-ROW-LINK-FAIL')) }
  { const grid = [header, ['山田 太郎', '30', '渋谷', 'リンク'], ['佐藤 花子', '40', '横浜', '']]
    const links = [{ cell: 'D2', url: 'https://docs.google.com/spreadsheets/d/' + 'R'.repeat(30) + '/edit' }]
    const l = L(); const r = await expandRosterEntries([e({ grid, links, content: '' })], l, 0)
    check('ER-06', 'expandRosterEntries', 'リンク取得の時間予算超過 → 取得せず埋め込みに降格（C-ROW-LINK-SKIP）', '予算0msで実行',
      r.length === 2 && codes(l).includes('C-ROW-LINK-SKIP') && r[0].content.includes('docs.google.com')) }
}

// ═══ ゾーンD: gateSingleCandidate ══════════════════════════════════════════
{
  resetDeps()
  { const l = L(); const r = gateSingleCandidate({ name: null }, [e({})], l)
    check('GS-01', 'gateSingleCandidate', '本文の氏名なし → 全許可（従来動作）', 'name=null',
      r.assigned.length === 1 && codes(l).includes('D-GATE-NONAME')) }
  { const l = L(); const r = gateSingleCandidate({ name: 'あ' }, [e({})], l)
    check('GS-02', 'gateSingleCandidate', '氏名が正規化後2字未満 → 全許可', 'name=あ（1字）',
      r.assigned.length === 1 && codes(l).includes('D-GATE-NONAME')) }
  { const l = L()
    const r = gateSingleCandidate({ name: '山田 太郎' },
      [e({ entryId: 1, filename: '山田太郎_経歴書.xlsx' }), e({ entryId: 2, content: '氏名 山田太郎 の経歴' })], l)
    check('GS-03', 'gateSingleCandidate', '本人名がファイル名/中身に一致 → 割当（D-GATE-OK）', 'ファイル名一致+中身一致',
      r.assigned.length === 2 && r.rejected.length === 0 && codes(l).includes('D-GATE-OK')) }
  { const l = L()
    const r = gateSingleCandidate({ name: '山田 太郎' },
      [e({ entryId: 1, rosterRowName: '佐藤 花子', content: '別人の名簿行' })], l)
    check('GS-04', 'gateSingleCandidate', '別人の名簿行 → 除外（D-GATE-REJ）', 'rosterRowName=佐藤',
      r.rejected.length === 1 && r.assigned.length === 0 && codes(l).includes('D-GATE-REJ')) }
  { const l = L()
    const r = gateSingleCandidate({ name: '山田 太郎' }, [e({ entryId: 1, filename: 'generic.xlsx', content: '氏名の記載なし' })], l)
    check('GS-05', 'gateSingleCandidate', '氏名シグナルなし → 許可（D-GATE-ALL・誤紐づけ防止は明確な他人のみ）', '汎用ファイル',
      r.assigned.length === 1 && codes(l).includes('D-GATE-ALL')) }
  { const l = L()
    const r = gateSingleCandidate({ name: '山田 太郎' },
      [e({ entryId: 1, rosterRowName: '山田太郎', content: '本人名は中身に無い名簿行' })], l)
    check('GS-06', 'gateSingleCandidate', '名簿行の氏名が本人と同一 → 除外しない', 'rosterRowName=山田太郎（表記ゆれ）',
      r.rejected.length === 0 && r.assigned.length === 1) }
}

// ═══ ゾーンD: promoteUnassignedRosterEntries ═══════════════════════════════
{
  { const l = L()
    const out = promoteUnassignedRosterEntries([e({ entryId: 1, rosterRowName: '山田太郎', content: 'row1' })], ['山田 太郎'], l)
    check('PU-01', 'promoteUnassigned', '既存ブロックと同名（正規化一致） → 昇格しない', '山田太郎 vs 山田 太郎',
      out.length === 0) }
  { const l = L()
    const out = promoteUnassignedRosterEntries([e({ entryId: 1, rosterRowName: '佐藤 花子', content: 'row1' })], ['山田 太郎'], l)
    check('PU-02', 'promoteUnassigned', '新規の名簿行 → 昇格（D-NEWBLOCK）', '佐藤（既存=山田のみ）',
      out.length === 1 && out[0].name === '佐藤 花子' && codes(l).includes('D-NEWBLOCK')) }
  { const l = L()
    const out = promoteUnassignedRosterEntries([e({ entryId: 1, content: '名簿行でないエントリ' })], [], l)
    check('PU-03', 'promoteUnassigned', 'rosterRowNameなし → 対象外', '通常エントリ', out.length === 0) }
  { const l = L()
    const out = promoteUnassignedRosterEntries([e({ entryId: 1, rosterRowName: '亜' })], [], l)
    check('PU-04', 'promoteUnassigned', '氏名2字未満 → 対象外', '1字の名前', out.length === 0) }
  { const l = L()
    const out = promoteUnassignedRosterEntries(
      [e({ entryId: 1, rosterRowName: 'I.S', content: 'a' }), e({ entryId: 2, rosterRowName: 'I.S', content: 'b' })], [], l)
    check('PU-05', 'promoteUnassigned', '名簿内の同名重複 → 2件目はスキップ', 'I.S×2行', out.length === 1) }
}

// ═══ ゾーンE: pickBodyResumeLink ═══════════════════════════════════════════
{
  const sheets = 'https://docs.google.com/spreadsheets/d/' + 'P'.repeat(30) + '/edit'
  const drive = 'https://drive.google.com/file/d/' + 'P'.repeat(30) + '/view'
  check('PB-01', 'pickBodyResumeLink', 'GoogleURLなし → null', 'リンクなし本文',
    pickBodyResumeLink('リンクはありません') === null)
  check('PB-02', 'pickBodyResumeLink', '経歴書キーワード直後200字以内のURL優先', 'スキルシート→URL',
    pickBodyResumeLink(`スキルシートはこちら: ${drive}\n参考: ${sheets}`) === drive)
  check('PB-03', 'pickBodyResumeLink', 'キーワードなし → Sheetsを優先', 'drive+sheets並記',
    pickBodyResumeLink(`${drive} と ${sheets}`)?.includes('spreadsheets') === true)
  check('PB-04', 'pickBodyResumeLink', 'Sheetsなし → 先頭のURL', 'driveのみ',
    pickBodyResumeLink(`資料 ${drive}`) === drive)
}

// ═══ ゾーンE: resolveResumeUrl ═════════════════════════════════════════════
{
  resetDeps()
  const bytes = { data: 'QUJD', mimeType: 'application/x', name: 'a.xlsx' }
  { deps.uploadToStorage = () => Promise.resolve('https://storage/1')
    const l = L(); const r = await resolveResumeUrl([e({ entryId: 1, attachment: bytes })], [], null, '山田', l)
    check('RR-01', 'resolveResumeUrl', '本人割当ファイルのStorage成功 → 最優先で採用', '割当1件 upload成功',
      r === 'https://storage/1' && codes(l).includes('E-URL-STORAGE')) }
  { let call = 0
    deps.uploadToStorage = () => Promise.resolve(++call === 1 ? null : 'https://storage/2')
    const l = L(); const r = await resolveResumeUrl(
      [e({ entryId: 1, attachment: bytes }), e({ entryId: 2, attachment: bytes })], [], null, '山田', l)
    check('RR-02', 'resolveResumeUrl', '1件目のStorage失敗 → 次の割当ファイルで成功', 'upload: 失敗→成功',
      r === 'https://storage/2' && codes(l).includes('E-STO-FAIL')) }
  { deps.uploadToStorage = () => Promise.resolve('https://storage/3')
    const l = L(); const r = await resolveResumeUrl([], [{ name: 'scan.pdf', mimeType: 'application/pdf', data: 'AA' }], null, null, l)
    check('RR-03', 'resolveResumeUrl', '割当なし → 未解析添付（スキャンPDF等）のフォールバック', 'rawにPDF1件',
      r === 'https://storage/3' && codes(l).includes('未解析添付フォールバック')) }
  { const l = L(); const r = await resolveResumeUrl([], [{ name: 'photo.png', mimeType: 'image/png', data: 'AA' }], null, null, l)
    check('RR-04', 'resolveResumeUrl', 'Office/PDF以外の添付は対象外 → なしなら null', 'raw=画像のみ',
      r === null && codes(l).includes('E-URL-NONE')) }
  { deps.uploadToStorage = () => Promise.resolve(null)
    const l = L(); const r = await resolveResumeUrl([e({ entryId: 1, attachment: bytes })], [], 'https://body/link', '山田', l)
    check('RR-05', 'resolveResumeUrl', '割当bytesありでStorage全滅 → 本文リンク + INV-E-BODYLINK-SKIP記録', 'upload全null+本文リンク',
      r === 'https://body/link' && l.invariantViolations.some((v: string) => v.includes('INV-E-BODYLINK-SKIP'))) }
  { const l = L(); const r = await resolveResumeUrl([], [], 'https://body/link', null, l)
    check('RR-06', 'resolveResumeUrl', 'Storage候補なし+本文リンクあり → 本文リンク（違反なし）', '本文リンクのみ',
      r === 'https://body/link' && l.invariantViolations.length === 0 && codes(l).includes('E-URL-BODYLINK')) }
  { const l = L(); const r = await resolveResumeUrl([], [], null, null, l)
    check('RR-07', 'resolveResumeUrl', '全ソースなし → null（E-URL-NONE）', '割当/raw/リンク全て空',
      r === null && codes(l).includes('E-URL-NONE')) }
}

// ═══ ゾーンE: pickSkillYears ═══════════════════════════════════════════════
{
  { const l = L()
    const r = pickSkillYears([e({ entryId: 1, skillYears: { _totalProjectMonths: 10 } }), e({ entryId: 2, skillYears: { Java: 24 } })], l)
    check('PS-01', 'pickSkillYears', '実スキル名を持つエントリを優先採用', '内部キーのみ vs Java:24',
      r.Java === 24 && codes(l).includes('E-SY-FROM')) }
  { const l = L()
    const r = pickSkillYears([e({ entryId: 1, skillYears: { _totalProjectMonths: 10 } })], l)
    check('PS-02', 'pickSkillYears', '内部キーのみのエントリ → 第2優先で採用', '_totalProjectMonths=10',
      r._totalProjectMonths === 10 && codes(l).includes('内部キーのみ')) }
  { const l = L()
    const r = pickSkillYears([e({ entryId: 1, totalProjectMonths: 36 })], l)
    check('PS-03', 'pickSkillYears', 'Wordのプロジェクト月数 → 第3優先で採用', 'totalProjectMonths=36',
      r._totalProjectMonths === 36 && codes(l).includes('word月数')) }
  { const l = L()
    check('PS-04', 'pickSkillYears', '全エントリにskillYearsなし → 空', 'skillYearsなし2件',
      Object.keys(pickSkillYears([e({ entryId: 1 }), e({ entryId: 2 })], l)).length === 0) }
}

// ── 結果出力 ────────────────────────────────────────────────────────────────
const passed = rows.filter(r => r.ok).length
const failed = rows.length - passed
console.log(`\n═══ 分岐網羅テスト結果 ═══`)
const byFn = new Map<string, { p: number; f: number }>()
for (const r of rows) {
  const s = byFn.get(r.fn) ?? { p: 0, f: 0 }
  r.ok ? s.p++ : s.f++
  byFn.set(r.fn, s)
}
for (const [fn, s] of byFn) console.log(`  ${s.f === 0 ? '✅' : '❌'} ${fn}: ${s.p}/${s.p + s.f}`)
console.log(`\n📊 ${passed} passed / ${failed} failed（全${rows.length}分岐）`)

Deno.writeTextFileSync('scripts/_branch_results.json', JSON.stringify(rows, null, 1))
console.log('📝 scripts/_branch_results.json を出力しました')
if (failed > 0) Deno.exit(1)
