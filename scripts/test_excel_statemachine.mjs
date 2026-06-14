/**
 * Excel ステートマシン ローカルテスト
 * Usage: node scripts/test_excel_statemachine.mjs <path-to-xlsx>
 *
 * Edge Function の spanCellsToJson / worksheetToCells を Node.js で再現し、
 * 実際の Excel ファイルに対して出力を検証する。
 */
import { readFileSync } from 'fs'
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx'

const filePath = process.argv[2] ?? '/Users/kazukimiyamura/Downloads/D.U_浦和駅.xlsx'

// ─── 定数 ─────────────────────────────────────────────────────────────────

const DECORATION_RE = /^[─━═\-=＝_＿◆◇■□●○▶▷▲△※＊\*・⁻\+×÷…‥†‡§¶@＠#＃$＄%％\^＾&＆|｜~～ーー]{2,}$/

const COL_HEADER_DICT =
  /^(計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始|終了|業務内容|案件名|使用言語|使用技術|技術スタック|担当工程|役割|規模|開発人数|ITコンサル|PM|PMO|TL|SE|PL|PG|マネージャー|リーダー|メンバー)$/

// ─── ユーティリティ ────────────────────────────────────────────────────────

function encodeXlsxCell(r, c) {
  let col = ''
  let n = c + 1
  while (n > 0) {
    col = String.fromCharCode(((n - 1) % 26) + 65) + col
    n = Math.floor((n - 1) / 26)
  }
  return col + (r + 1)
}

function decodeXlsxRange(ref) {
  const decodeAddr = (addr) => {
    const m = addr.match(/^([A-Z]+)(\d+)$/)
    if (!m) return { r: 0, c: 0 }
    const col = m[1].split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1
    return { r: parseInt(m[2]) - 1, c: col }
  }
  const parts = ref.split(':')
  return { s: decodeAddr(parts[0]), e: decodeAddr(parts[1] || parts[0]) }
}

// ─── worksheetToCells（Edge Function と同一ロジック）──────────────────────

function worksheetToCells(sheet) {
  const cells = []
  const ref = sheet['!ref']
  if (!ref) return cells
  const range = decodeXlsxRange(ref)
  const merges = sheet['!merges'] || []
  const mergeInfo = new Map()
  const skipCells = new Set()
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
      const cell = sheet[encodeXlsxCell(r, c)]
      const info = mergeInfo.get(`${r},${c}`)
      const rowEnd = info?.rowEnd ?? r
      const colEnd = info?.colEnd ?? c
      const val = String(cell?.w ?? (cell?.v !== undefined ? cell.v : '')).replace(/\r\n?/g, '\n').trim()
      if (val) cells.push({ row: r, col: c, colEnd, rowEnd, value: val })
    }
  }
  return cells
}

// ─── ステートマシン（Edge Function と同一ロジック）────────────────────────

const _cs = (c) => c.colEnd - c.col + 1
const _rs = (c) => c.rowEnd - c.row + 1

function _isContainer(cell, key) {
  let s = 0
  if (_rs(cell) > _rs(key))                    s += 1
  if (_cs(cell) > 2)                           s += 1
  if (cell.col === 0 || cell.col === 1)        s += 1
  if (COL_HEADER_DICT.test(cell.value.trim())) s += 2
  return s >= 2
}

function _childCells(all, cont) {
  return all.filter(c =>
    c !== cont &&
    c.row  >= cont.row  && c.rowEnd  <= cont.rowEnd &&
    c.col  >= cont.col  && c.colEnd  <= cont.colEnd
  )
}

function _belowCell(sorted, key) {
  return sorted.find(c =>
    c.row === key.rowEnd + 1 && c.col >= key.col && c.col <= key.colEnd
  )
}

function _findHdr(map, col) {
  for (const [c, h] of map) if (col >= c && col <= h.colEnd) return h.text
  return undefined
}

function _scanContainer(cells) {
  const rows = spanCellsToJson(cells)
  const merged = {}
  for (const r of rows) Object.assign(merged, r)
  return merged
}

function spanCellsToJson(cells) {
  if (cells.length === 0) return []

  const sorted = [...cells].sort((a, b) =>
    a.row !== b.row ? a.row - b.row : a.col - b.col
  )
  const byRow = new Map()
  for (const c of sorted) {
    if (!byRow.has(c.row)) byRow.set(c.row, [])
    byRow.get(c.row).push(c)
  }
  const rowNums = [...byRow.keys()].sort((a, b) => a - b)

  const results = []
  let colHeaderMap = new Map()
  const usedRows = new Set()

  for (const rowNum of rowNums) {
    if (usedRows.has(rowNum)) continue

    const rowCells = (byRow.get(rowNum) ?? []).filter(c => c.value.trim())
    if (rowCells.length === 0) continue

    // READ_COL_HEADERS モード
    if (colHeaderMap.size > 0) {
      const matRec = {}
      let matched = false
      for (const cell of rowCells) {
        const hdr = _findHdr(colHeaderMap, cell.col)
        if (hdr) {
          matRec[hdr] = matRec[hdr] ? matRec[hdr] + '\n' + cell.value.trim() : cell.value.trim()
          matched = true
        }
      }
      if (!matched) {
        colHeaderMap = new Map()
      } else {
        if (Object.keys(matRec).length > 0) results.push(matRec)
        continue
      }
    }

    // 通常モード
    const record = {}
    let i = 0
    let newRow = false

    while (i < rowCells.length && !newRow) {
      const key = rowCells[i]
      const right = rowCells[i + 1]

      if (right) {
        if (_rs(right) < _rs(key) && COL_HEADER_DICT.test(right.value.trim())) {
          for (let k = i + 1; k < rowCells.length; k++) {
            const hc = rowCells[k]
            if (hc.value.trim()) colHeaderMap.set(hc.col, { text: hc.value.trim(), colEnd: hc.colEnd })
          }
          newRow = true

        } else if (_isContainer(right, key)) {
          const ch = _childCells(sorted, right)
          record[key.value.trim()] = _scanContainer(ch)
          for (let r = right.row; r <= right.rowEnd; r++) usedRows.add(r)
          i += 2; newRow = true

        } else if (_rs(right) === _rs(key)) {
          record[key.value.trim()] = right.value.trim()
          i += 2

        } else if (_rs(right) < _rs(key)) {
          const ch = _childCells(sorted, right)
          record[right.value.trim()] = _scanContainer(ch)
          for (let r = right.row; r <= right.rowEnd; r++) usedRows.add(r)
          i += 2; newRow = true

        } else {
          i++
        }

      } else {
        const below = _belowCell(sorted, key)

        if (!below) {
          i++
        } else if (_cs(below) > _cs(key) && _isContainer(below, key)) {
          const ch = _childCells(sorted, below)
          record[key.value.trim()] = _scanContainer(ch)
          for (let r = below.row; r <= below.rowEnd; r++) usedRows.add(r)
          i++; newRow = true

        } else if (_cs(below) >= _cs(key)) {
          record[key.value.trim()] = below.value.trim()
          usedRows.add(below.row)
          i++

        } else {
          const ch = _childCells(sorted, key)
          record[key.value.trim()] = _scanContainer(ch)
          for (let r = key.row + 1; r <= key.rowEnd; r++) usedRows.add(r)
          i++; newRow = true
        }
      }
    }

    if (Object.keys(record).length > 0) results.push(record)
  }

  return results
}

// ─── extractSkillYearsFromSheetJson（Edge Function と同一ロジック）─────────

function parseDurationToMonths(text) {
  if (!text) return null
  const m1 = text.match(/(\d+)\s*ヶ?月/)
  if (m1) return parseInt(m1[1])
  const m2 = text.match(/(\d+)\s*年\s*(?:(\d+)\s*ヶ?月)?/)
  if (m2) return parseInt(m2[1]) * 12 + parseInt(m2[2] ?? '0')
  return null
}

function extractSkillYearsFromSheetJson(rows) {
  if (rows.length === 0) return {}
  const headers = Object.keys(rows[0])

  const PERIOD_COL  = /^(期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始.{0,4}終了)$/
  const START_COL   = /^(開始|開始年月|FROM|開始日)$/i
  const END_COL     = /^(終了|終了年月|TO|終了日)$/i
  const DURATION_COL = /^(期間\(月\)|月数|期間月数|経験月数|在籍月数|Months?)$/i
  const SKILL_COL   = /使用言語|使用技術|技術スタック|技術(?!力|的)|言語(?!\s*能)|FW|フレームワーク|ミドル|ツール|DB(?!A)|OS(?!\s*名)|インフラ|skill/i

  const periodCol   = headers.find(h => PERIOD_COL.test(h.trim()))
  const startCol    = headers.find(h => START_COL.test(h.trim()))
  const endCol      = headers.find(h => END_COL.test(h.trim()))
  const durationCol = headers.find(h => DURATION_COL.test(h.trim()))
  const skillCols   = headers.filter(h => SKILL_COL.test(h.trim()))

  console.log('  [skillYears] headers:', headers.join(', '))
  console.log('  [skillYears] periodCol:', periodCol, 'startCol:', startCol, 'endCol:', endCol, 'durationCol:', durationCol)
  console.log('  [skillYears] skillCols:', skillCols)

  if (skillCols.length === 0) return {}

  const skillMonths = {}
  const projectPeriods = []
  const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1

  const parseYM = (s) => {
    const m = s.match(/(\d{4})[\/\-年](\d{1,2})/)
    return m ? parseInt(m[1]) * 12 + parseInt(m[2]) : null
  }
  const resolveEndYM = (s) => {
    if (/現在|今|present|継続|在籍中/i.test(s)) return nowYM
    return parseYM(s)
  }

  for (const row of rows) {
    let months = null
    let startYM = null
    let endYM = null

    if (durationCol) months = parseDurationToMonths(row[durationCol] ?? '')
    if (!months && periodCol && row[periodCol]) {
      const ptext = row[periodCol]
      const m = ptext.match(/(\d{4}[\/年]\d{1,2})\s*[〜～\-〜]\s*(\S+)/)
      if (m) {
        startYM = parseYM(m[1])
        endYM   = resolveEndYM(m[2])
        if (startYM && endYM) months = endYM - startYM + 1
      } else {
        months = parseDurationToMonths(ptext)
      }
    }
    if (!months && startCol && endCol && row[startCol] && row[endCol]) {
      startYM = parseYM(row[startCol])
      endYM   = resolveEndYM(row[endCol])
      if (startYM && endYM) months = endYM - startYM + 1
    }

    if (!months || months <= 0 || months > 600) continue
    if (startYM && endYM) projectPeriods.push({ startYM, endYM })

    for (const col of skillCols) {
      const val = row[col] ?? ''
      const JSON_SKILL_BLOCKLIST = /^(自己PR|PR|備考|補足|資格|氏名|年齢|性別|国籍|住所|学歴|経歴|担当|役割|役職|ポジション|立場|評価|合計|スコア|レベル|プロジェクト名|企業名|規模|人数|期間|開始|終了|弊社社員|自社社員|社員|派遣|契約|フリー|なし|特になし|未経験|なし$)$/
      const skills = val.split(/[\n\r、，,\/・]+/).map(s => s.trim()).filter(s => s && s !== '-' && s !== '－' && s.length >= 2 && !/^\d+$/.test(s) && !JSON_SKILL_BLOCKLIST.test(s))
      for (const skill of skills) {
        skillMonths[skill] = (skillMonths[skill] ?? 0) + months
      }
    }
  }

  if (projectPeriods.length > 0) {
    skillMonths['_totalProjectMonths'] = projectPeriods.reduce((s, p) => s + (p.endYM - p.startYM + 1), 0)
    const allStarts = projectPeriods.map(p => p.startYM)
    const allEnds   = projectPeriods.map(p => p.endYM)
    const span = Math.max(...allEnds) - Math.min(...allStarts) + 1
    if (span > 0) skillMonths['_dateSpanMonths'] = span
  }
  return skillMonths
}

// ─── メイン ───────────────────────────────────────────────────────────────

console.log('=== Excel ステートマシン ローカルテスト ===')
console.log('ファイル:', filePath)
console.log()

const buf = readFileSync(filePath)
const wb = xlsxRead(buf, { type: 'buffer', cellDates: false, raw: false })

console.log('シート一覧:', wb.SheetNames)
console.log()

for (const sheetName of wb.SheetNames) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`シート: ${sheetName}`)
  console.log('='.repeat(60))

  const sheet = wb.Sheets[sheetName]
  const cells = worksheetToCells(sheet)

  console.log(`SpanCell 数: ${cells.length}`)

  // セルダンプ（上位20件）
  console.log('\n--- SpanCell サンプル (上位30件) ---')
  for (const c of cells.slice(0, 30)) {
    const rowSpan = c.rowEnd - c.row + 1
    const colSpan = c.colEnd - c.col + 1
    const span = (rowSpan > 1 || colSpan > 1) ? ` [r${rowSpan}×c${colSpan}]` : ''
    console.log(`  (${c.row},${c.col})${span}: ${JSON.stringify(c.value.slice(0, 40))}`)
  }

  // ステートマシン実行
  console.log('\n--- ステートマシン出力 ---')
  const smOutput = spanCellsToJson(cells)
  console.log(`出力レコード数: ${smOutput.length}`)
  console.log(JSON.stringify(smOutput, null, 2).slice(0, 5000))

  // extractSkillYearsFromSheetJson テスト
  const flatRows = smOutput.filter(r => typeof r === 'object' && !Array.isArray(r))
  console.log('\n--- extractSkillYearsFromSheetJson ---')
  const skillYears = extractSkillYearsFromSheetJson(flatRows)
  console.log('skillYears:', JSON.stringify(skillYears, null, 2))
}
