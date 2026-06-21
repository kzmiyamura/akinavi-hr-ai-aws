/**
 * Excel ステートマシン ローカルテスト
 * Usage: node scripts/test_excel_statemachine.mjs <path-to-xlsx>
 *
 * Edge Function の processExcelWithStateMachine / worksheetToCells を Node.js で再現し、
 * 実際の Excel ファイルに対して出力を検証する。
 */
import { readFileSync } from 'fs'
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx'

const filePath = process.argv[2] ?? '/Users/kazukimiyamura/Downloads/D.U_浦和駅.xlsx'

// ─── 定数（Edge Function と同一）─────────────────────────────────────────

const STRUCTURE_KEY_DICT =
  /^(No\.?|計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始|終了|業務内容|内容|案件名|使用言語|使用技術|技術スタック|担当工程|規模|開発人数|備考|ポジション|チーム規模|担当業務|氏名|ふりがな|フリガナ|年齢|性別|住所|最寄駅?|学歴|最終学歴|卒業|生年月日?|連絡先|電話番号?|メールアドレス?|経験年数?|資格|保有資格|国籍|在住|所属|会社名|企業名|スキルサマリ[ー]?|自己PR|PR|アピールポイント|強み|希望勤務|希望単価|参画時期|稼働|業務経験|知識有り)$/

const TAG_DICT =
  /^(No\.?|計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始|終了|業務内容|内容|案件名|使用言語|使用技術|技術スタック|担当工程|役割|規模|開発人数|ITコンサル|PM|PMO|TL|SE|PL|PG|マネージャー|リーダー|メンバー|備考|ポジション|チーム規模|担当業務|氏名|ふりがな|フリガナ|年齢|性別|住所|最寄駅?|学歴|最終学歴|卒業|生年月日?|連絡先|電話番号?|メールアドレス?|経験年数?|資格|保有資格|国籍|在住|所属|会社名|企業名|スキルサマリ[ー]?|自己PR|PR|アピールポイント|強み|希望勤務|希望単価|参画時期|稼働|補足|メモ|コメント|環境|言語|OS|DB|ツール|開発環境|フレームワーク|クラウド|インフラ|ミドルウェア|その他|立場|開発規模|人数|スキル|コンピュータ言語|サーバ[ー]?OS|業務経験|知識有り)$/

const Sm = { START: 0, KEY_H: 1, KEY_V: 2, END: 3 }

// ─── ユーティリティ（Edge Function と同一）────────────────────────────────

const _cs = (c) => c.colEnd - c.col + 1   // colSpan
const _rs = (c) => c.rowEnd - c.row + 1   // rowSpan

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

// ─── 状態機械（Edge Function processExcelWithStateMachine と同一）────────

function getBounds(cells) {
  if (cells.length === 0) return null
  let minRow = Infinity, minCol = Infinity
  let maxRow = -Infinity, maxCol = -Infinity
  for (const c of cells) {
    minRow = Math.min(minRow, c.row)
    minCol = Math.min(minCol, c.col)
    maxRow = Math.max(maxRow, c.rowEnd)
    maxCol = Math.max(maxCol, c.colEnd)
  }
  return { topLeft: [minRow, minCol], bottomRight: [maxRow, maxCol] }
}

function findCellAtCoord(cells, row, col) {
  return cells.find(c =>
    row >= c.row && row <= c.rowEnd &&
    col >= c.col && col <= c.colEnd
  )
}

function getNextCoord(cell, state) {
  if (!cell) return [0, 0]
  if (state === 'KEY_H') return [cell.row, cell.colEnd + 1]
  return [cell.rowEnd + 1, cell.col]
}

function handleStart(cell, row, col, context, skillNameSet) {
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
        context.currentRecord = context.recordStack.pop()
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

  context.inSkillDeepDive = skillNameSet.has(keyValue.toLowerCase().replace(/\s+/g, ''))

  return [Sm.KEY_H, getNextCoord(cell, 'KEY_H'), true]
}

function handleKeyH(cell, row, col, context, skillNameSet) {
  const right = cell
  if (!right) {
    // キーバリュー成立: undefined を "" に変換
    const keyName = context.smKey.value.trim()
    if (context.currentRecord[keyName] === undefined || context.currentRecord[keyName] === "") {
      context.currentRecord[keyName] = ""
    }
    return [Sm.KEY_H, [row, col + 1], false]
  }
  const key = context.smKey
  const keyRS = _rs(key)
  const rightRS = _rs(right)
  const rightValue = right.value.trim()
  const keyValue = key.value.trim()

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

    context.inSkillDeepDive = skillNameSet.has(rightValue.toLowerCase().replace(/\s+/g, ''))

    return [Sm.KEY_H, getNextCoord(cell, 'KEY_H'), true]
  }

  if (rightRS < keyRS) {
    if (TAG_DICT.test(rightValue)) {
      // コンテナ昇格: key の値を {} にし、その中に rightValue をキーとして追加
      const keyName = key.value.trim()
      const newContainer = {}
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
      context.currentRecord = context.recordStack.pop()
      context.keyStack.pop()
    } else {
      // はみ出ていない → 親内におさまっている
      break
    }
  }

  // 共通：値確定処理
  const keyName = key.value.trim()

  if (context.currentRecord[keyName] === undefined || context.currentRecord[keyName] === "") {
    context.currentRecord[keyName] = rightValue
  } else if (Array.isArray(context.currentRecord[keyName])) {
    if (rightValue !== "") {
      context.currentRecord[keyName].push(rightValue)
    }
  } else {
    if (rightValue !== "") {
      const existing = context.currentRecord[keyName]
      context.currentRecord[keyName] = [existing, rightValue]
    }
  }
  // 値確定後は さらなるバリューを求めてKEY_Hのまま次へ
  return [Sm.KEY_H, getNextCoord(key, 'KEY_H'), true]
}

function handleKeyV(cell, row, col, context, skillNameSet) {
  const below = cell
  if (!below) {
    // 下セルなし → キーの値は空文字のまま確定、親に遡って兄弟キーを探す
    if (context.recordStack.length > 1) {
      context.currentRecord = context.recordStack.pop()
      context.keyStack.pop()
      return [Sm.KEY_H, getNextCoord(context.smKey, 'KEY_H'), false]
    }
    // 右セルなし → START へ
    const nextCoord = getNextCoord(context.smKey, 'KEY_H')
    context.smKey = null
    return [Sm.START, nextCoord, false]
  }

  const key = context.smKey
  const keyCS = _cs(key)
  const belowCS = _cs(below)
  const belowValue = below.value.trim()

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
    const newContainer = {}
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
        (parentContainer.rowEnd < below.row && below.colEnd < parentContainer.colEnd)) { // 縦の子のはみ出し
      // はみ出ている → 親から独立
      context.currentRecord = context.recordStack.pop()
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
    if (belowValue !== "") {
      context.currentRecord[keyName].push(belowValue)
    }
  } else {
    if (belowValue !== "") {
      const existing = context.currentRecord[keyName]
      context.currentRecord[keyName] = [existing, belowValue]
    }
  }
  return [Sm.KEY_V, getNextCoord(below, 'KEY_V'), true]
}

/** 座標ベースのステートマシン走査メインループ（Edge Function processExcelWithStateMachine と同一） */
function processExcelWithStateMachine(cells, skillNameSet, sheetName = 'Sheet') {
  const bounds = getBounds(cells)
  if (!bounds) return {}

  const [minRow, minCol] = bounds.topLeft
  const [maxRow, maxCol] = bounds.bottomRight

  const record = { [sheetName]: {} }
  let row = minRow
  let col = minCol
  let state = Sm.START
  let flg = false
  let currentRecord = record[sheetName]
  const context = {
    smKey: null,
    currentRecord: currentRecord,
    recordStack: [record[sheetName]],
    keyStack: [],  // コンテナ昇格時の親キー（セル情報付き）
    inSkillDeepDive: false,
    visited: new Set()
  }

  while (row <= maxRow) {
    const cell = findCellAtCoord(cells, row, col)

    // 処理済みセルは2回処理しない
    if (context.visited.has(cell)) {
      col++
    } else {
      switch (state) {
        case Sm.START:
          [state, [row, col], flg] = handleStart(cell, row, col, context, skillNameSet)
          break
        case Sm.KEY_H:
          [state, [row, col], flg] = handleKeyH(cell, row, col, context, skillNameSet)
          break
        case Sm.KEY_V:
          [state, [row, col], flg] = handleKeyV(cell, row, col, context, skillNameSet)
          break
        case Sm.END:
          row = maxRow + 1
          break
        default:
          row = maxRow + 1
      }
      if (flg) {
        context.visited.add(cell)
      }
    }

    // 右端到達で次行へ
    if (col > maxCol) {
      if (state === Sm.KEY_H) {
        const keyName = context.smKey.value.trim()
        if (context.currentRecord[keyName] === undefined || context.currentRecord[keyName] === "") {
          context.currentRecord[keyName] = ""
        }
      }
      row++
      col = minCol
      state = Sm.START
    }
  }

  return record
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

function extractSkillYearsFromSheetJson(record) {
  // processExcelWithStateMachine は 1 つの record（オブジェクト）を返す
  // extractSkillYearsFromSheetJson は旧版と同じく rows 配列を期待するので変換
  const rows = Array.isArray(record) ? record : [record]
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
      if (typeof val !== 'string') continue
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

// skillNameSet: ローカルテストでは空（skill_master DB 接続なし）
const skillNameSet = new Set()

for (const sheetName of wb.SheetNames) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`シート: ${sheetName}`)
  console.log('='.repeat(60))

  const sheet = wb.Sheets[sheetName]
  const cells = worksheetToCells(sheet)

  console.log(`SpanCell 数: ${cells.length}`)

  // セルダンプ（上位30件）
  console.log('\n--- SpanCell サンプル (上位30件) ---')
  for (const c of cells.slice(0, 30)) {
    const rowSpan = c.rowEnd - c.row + 1
    const colSpan = c.colEnd - c.col + 1
    const span = (rowSpan > 1 || colSpan > 1) ? ` [r${rowSpan}×c${colSpan}]` : ''
    console.log(`  (${c.row},${c.col})${span}: ${JSON.stringify(c.value.slice(0, 60))}`)
  }

  // ステートマシン実行
  console.log('\n--- ステートマシン出力 ---')
  const smOutput = processExcelWithStateMachine(cells, skillNameSet, sheetName)
  const keys = Object.keys(smOutput)
  console.log(`出力キー数: ${keys.length}`)
  console.log(JSON.stringify(smOutput, null, 2).slice(0, 5000))

  // extractSkillYearsFromSheetJson テスト
  console.log('\n--- extractSkillYearsFromSheetJson ---')
  const skillYears = extractSkillYearsFromSheetJson(smOutput)
  console.log('skillYears:', JSON.stringify(skillYears, null, 2))
}
