/**
 * ローカルファイルに対してskillYears抽出ロジックをテストする
 *
 * 使い方:
 *   node scripts/test_excel_parsing.mjs             # 詳細出力（デバッグ用）
 *   node scripts/test_excel_parsing.mjs --compact   # メトリクス表のみ（Claude読み取り用）
 *   node scripts/test_excel_parsing.mjs --log "改善メモ"  # compact + improvement_log.md 追記
 *   node scripts/test_excel_parsing.mjs --new       # testData/*.xlsx（未分類）も検証
 *
 * 関数は _extractors.gen.mjs からインポート（index.ts と常に同期）
 * 再同期: node scripts/sync_extractors.mjs
 */
import { readdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs'
import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  extractSkillYearsFromSheetData,
  extractSkillYearsFromBodyText,
} from './_extractors.gen.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const excelDir   = join(__dirname, 'testData/excel')
const failureDir = join(__dirname, 'testData/failures')
const newDir     = join(__dirname, 'testData')
const logFile    = join(__dirname, 'testData/improvement_log.md')
const goldenFile = join(__dirname, 'testData/excel_golden.json')

const args = process.argv.slice(2)
const COMPACT  = args.includes('--compact') || args.includes('-c') || args.some(a => a === '--log')
const SHOW_NEW = args.includes('--new')
const UPDATE_GOLDEN = args.includes('--update-golden')
const logNoteIdx = args.indexOf('--log')
const LOG_NOTE = logNoteIdx >= 0 ? (args[logNoteIdx + 1] ?? '') : null

// compact モードでは [DBG] と gen.mjs の console.log を抑制
const dbg = COMPACT ? () => {} : (s) => process.stdout.write(s)
if (COMPACT) {
  const _origLog = console.log.bind(console)
  console.log = (...args) => {
    const msg = String(args[0] ?? '')
    if (msg.startsWith('[skillYears') || msg.startsWith('[DBG]') || msg.startsWith('[filterSkill')) return
    _origLog(...args)
  }
}

// ── テスト実行ヘルパー ────────��────────────────────────────────────

function scoreResult(result) {
  const skills = Object.entries(result).filter(([k]) => !k.startsWith('_'))
  if (skills.length > 0) return {
    status: 'pass',
    label: `${skills.length}スキル: ${skills.slice(0,3).map(([k,v])=>`${k}(${Math.round(v/12)}年)`).join(', ')}`,
  }
  if (result._totalProjectMonths) return {
    status: 'warn',
    label: `スキルなし/総月数=${result._totalProjectMonths}ヶ月`,
  }
  return { status: 'fail', label: '取得ゼロ' }
}

function runExcelFile(filePath, _fileName) {
  try {
    const wb = XLSX.readFile(filePath)
    for (const sheetName of wb.SheetNames.slice(0, 2)) {
      const ws = wb.Sheets[sheetName]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
        .map(row => row.map(c => String(c ?? '')))
      const result = extractSkillYearsFromSheetData(data)
      const s = scoreResult(result)
      if (!COMPACT) {
        const icon = s.status === 'pass' ? '✅' : s.status === 'warn' ? '⚠️ ' : '❌'
        console.log(`  ${icon} [${sheetName}] ${s.label}`)
      }
      if (s.status !== 'fail') return { status: s.status, result, sheetName }
    }
    return { status: 'fail', result: {}, sheetName: null }
  } catch (e) {
    dbg(`  [ERR] ${_fileName}: ${e.message}\n`)
    return { status: 'error', result: {}, sheetName: null }
  }
}

// ── ゴールデンテスト: 期待値スナップショットとの厳密比較 ──────────────
// 「取れた/取れない」だけでなく「値が正しいか」を回帰保証する。
// 期待値は excel_golden.json（--update-golden で現在の抽出値から再生成）。
// 「現在」終了案件は月が進むと値が動くため ±2ヶ月を一致として扱う
const GOLDEN_TOLERANCE = 2
function compareGolden(golden, result) {
  const g = golden.skills ?? {}
  const r = Object.fromEntries(Object.entries(result).filter(([k]) => !k.startsWith('_')))
  let match = 0
  const missing = []
  const valueDiff = []
  for (const [k, v] of Object.entries(g)) {
    if (r[k] === undefined) missing.push(k)
    else if (Math.abs(r[k] - v) <= GOLDEN_TOLERANCE) match++
    else valueDiff.push(`${k}:${v}→${r[k]}`)
  }
  const extra = Object.keys(r).filter(k => g[k] === undefined)
  return { match, missing, extra, valueDiff, total: Object.keys(g).length }
}

// ── メイン ────────────────────────────────────────────────────────

// 1. Excel テスト（testData/excel/*.xlsx）
const excelFiles = readdirSync(excelDir).filter(f => /\.(xlsx?|xls)$/i.test(f)).sort()
const excelResults = { pass: [], warn: [], fail: [], error: [] }

if (!COMPACT) console.log('\n=== Excel skillYears テスト (testData/excel/) ===')
let goldenData = null
try { goldenData = JSON.parse(readFileSync(goldenFile, 'utf-8')) } catch { /* 未生成 */ }
const goldenStats = { files: 0, match: 0, total: 0, missing: [], extra: [], valueDiff: [] }
const goldenNext = {}
for (const file of excelFiles) {
  if (!COMPACT) console.log(`\n${'─'.repeat(50)}\n${file}`)
  const { status, result, sheetName } = runExcelFile(join(excelDir, file), file)
  excelResults[status].push(file)
  goldenNext[file] = {
    sheet: sheetName,
    skills: Object.fromEntries(Object.entries(result).filter(([k]) => !k.startsWith('_'))),
    total: result._totalProjectMonths ?? null,
  }
  const g = goldenData?.files?.[file]
  if (g) {
    const c = compareGolden(g, result)
    goldenStats.files++
    goldenStats.match += c.match
    goldenStats.total += c.total
    goldenStats.missing.push(...c.missing.map(k => `${file}:${k}`))
    goldenStats.extra.push(...c.extra.map(k => `${file}:${k}`))
    goldenStats.valueDiff.push(...c.valueDiff.map(s => `${file}:${s}`))
    if (!COMPACT && (c.missing.length || c.valueDiff.length || c.extra.length)) {
      console.log(`  [golden] 欠落=${c.missing.join(',') || '-'} 値ズレ=${c.valueDiff.join(',') || '-'} 過剰=${c.extra.join(',') || '-'}`)
    }
  }
}
if (UPDATE_GOLDEN) {
  const out = {
    _note: '実ファイルの期待値スナップショット。--update-golden で再生成。値の正しさの人手確認状況は _verified を参照',
    _generated: new Date().toISOString().slice(0, 10),
    _verified: goldenData?._verified ?? '未確認（現状の抽出値のスナップショット）',
    files: goldenNext,
  }
  writeFileSync(goldenFile, JSON.stringify(out, null, 1))
  console.log(`✅ excel_golden.json を更新しました（${Object.keys(goldenNext).length}ファイル）`)
}

// 2. Body text テスト（testData/failures/*.txt）
const txtFiles = readdirSync(failureDir).filter(f => f.endsWith('.txt')).sort()
const txtResults = { pass: [], warn: [], fail: [], error: [] }

if (!COMPACT && txtFiles.length > 0) console.log('\n=== Body text skillYears テスト (testData/failures/*.txt) ===')
for (const file of txtFiles) {
  const text = readFileSync(join(failureDir, file), 'utf-8')
  const result = extractSkillYearsFromBodyText(text)
  const s = scoreResult(result)
  if (!COMPACT) {
    const icon = s.status === 'pass' ? '✅' : s.status === 'warn' ? '⚠️ ' : '❌'
    console.log(`  ${icon} ${file}: ${s.label}`)
  }
  txtResults[s.status].push(file)
}

// 3. New xlsx テ���ト（testData/*.xlsx）
const newFiles = SHOW_NEW
  ? readdirSync(newDir).filter(f => /\.(xlsx?|xls)$/i.test(f)).sort()
  : []
const newResults = { pass: [], warn: [], fail: [], error: [] }

if (SHOW_NEW && !COMPACT && newFiles.length > 0) console.log('\n=== New xlsx テスト (testData/*.xlsx) ===')
for (const file of newFiles) {
  if (!COMPACT) console.log(`\n${'─'.repeat(50)}\n${file}`)
  const { status } = runExcelFile(join(newDir, file), file)
  newResults[status].push(file)
}

// ── メトリクス表 ──────────���───────────────────────────────────────

const today = new Date().toISOString().slice(0, 10)

function pct(pass, warn, total) {
  if (total === 0) return 'N/A'
  return ((pass + warn) / total * 100).toFixed(1) + '%'
}

function metricsTable() {
  const excelTotal = excelFiles.length
  const excelPass  = excelResults.pass.length
  const excelWarn  = excelResults.warn.length
  const excelFail  = excelResults.fail.length + excelResults.error.length

  const txtTotal = txtFiles.length
  const txtPass  = txtResults.pass.length
  const txtWarn  = txtResults.warn.length
  const txtFail  = txtResults.fail.length + txtResults.error.length

  const newTotal = newFiles.length
  const newPass  = newResults.pass.length
  const newWarn  = newResults.warn.length
  const newFail  = newResults.fail.length + newResults.error.length

  const lines = [
    `=== Parse Quality Metrics (${today}) ===`,
    `種別                 Pass  Warn  Fail  Total  Rate`,
    `Excel skillYears     ${String(excelPass).padStart(4)}  ${String(excelWarn).padStart(4)}  ${String(excelFail).padStart(4)}  ${String(excelTotal).padStart(5)}  ${pct(excelPass, excelWarn, excelTotal)}`,
    `Body  skillYears     ${String(txtPass).padStart(4)}  ${String(txtWarn).padStart(4)}  ${String(txtFail).padStart(4)}  ${String(txtTotal).padStart(5)}  ${pct(txtPass, txtWarn, txtTotal)}`,
  ]
  if (SHOW_NEW && newTotal > 0) {
    lines.push(`New   xlsx           ${String(newPass).padStart(4)}  ${String(newWarn).padStart(4)}  ${String(newFail).padStart(4)}  ${String(newTotal).padStart(5)}  ${pct(newPass, newWarn, newTotal)}`)
  }

  if (goldenStats.files > 0) {
    const rate = goldenStats.total > 0 ? (goldenStats.match / goldenStats.total * 100).toFixed(1) : 'N/A'
    lines.push(`Golden 一致率: ${rate}%（一致${goldenStats.match}/${goldenStats.total} 欠落${goldenStats.missing.length} 値ズレ${goldenStats.valueDiff.length} 過剰${goldenStats.extra.length}・${goldenStats.files}ファイル）`)
    if (goldenStats.missing.length > 0) lines.push(`GOLDEN欠落: ${goldenStats.missing.slice(0, 8).join(', ')}${goldenStats.missing.length > 8 ? ` 他${goldenStats.missing.length - 8}` : ''}`)
    if (goldenStats.valueDiff.length > 0) lines.push(`GOLDEN値ズレ: ${goldenStats.valueDiff.slice(0, 8).join(', ')}${goldenStats.valueDiff.length > 8 ? ` 他${goldenStats.valueDiff.length - 8}` : ''}`)
  }

  const failingExcel = [...excelResults.fail, ...excelResults.error]
  const failingTxt   = [...txtResults.fail, ...txtResults.error]
  const failingNew   = [...newResults.fail, ...newResults.error]

  if (failingExcel.length > 0) lines.push(`\nFAILING Excel: ${failingExcel.join(', ')}`)
  if (excelResults.warn.length > 0) lines.push(`WARN    Excel: ${excelResults.warn.join(', ')}`)
  if (failingTxt.length > 0) lines.push(`FAILING Body:  ${failingTxt.join(', ')}`)
  if (failingNew.length > 0) lines.push(`FAILING New:   ${failingNew.slice(0,5).join(', ')}${failingNew.length > 5 ? ` (他${failingNew.length-5}件)` : ''}`)

  return lines.join('\n')
}

const table = metricsTable()
if (COMPACT) {
  console.log(table)
} else {
  console.log('\n' + table)
}

// ── improvement_log.md 追記 ──────────────────────���─────────────────

if (LOG_NOTE !== null) {
  const excelRate = pct(excelResults.pass.length, excelResults.warn.length, excelFiles.length)
  const txtRate   = pct(txtResults.pass.length,   txtResults.warn.length,   txtFiles.length)

  const entry = [
    ``,
    `## ${today} イテレーション（自動記録）`,
    `- **Excel skillYears**: ${excelRate}（Pass:${excelResults.pass.length} Warn:${excelResults.warn.length} Fail:${excelResults.fail.length + excelResults.error.length}/${excelFiles.length}）`,
    `- **Body skillYears**: ${txtRate}（Pass:${txtResults.pass.length} Warn:${txtResults.warn.length} Fail:${txtResults.fail.length + txtResults.error.length}/${txtFiles.length}）`,
    LOG_NOTE ? `- **メモ**: ${LOG_NOTE}` : null,
    ``,
    `---`,
    ``,
  ].filter(l => l !== null).join('\n')

  appendFileSync(logFile, entry, 'utf-8')
  console.log(`\n✅ improvement_log.md に追記しました`)
}
