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
  /^(No\.?|計画立案|要件定義|基本設計|詳細設計|外部設計|内部設計|製造|コーディング|単体試験|結合試験|総合試験|運用保守|期間|プロジェクト期間|PJ期間|参画期間|在籍期間|開始|終了|業務内容|内容|案件名|使用言語|使用技術|技術スタック|担当工程|役割|規模|開発人数|ITコンサル|PM|PMO|TL|SE|PL|PG|マネージャー|リーダー|メンバー|備考|ポジション|チーム規模|担当業務|氏名|ふりがな|フリガナ|年齢|性別|住所|最寄駅?|学歴|最終学歴|卒業|生年月日?|連絡先|電話番号?|メールアドレス?|経験年数?|資格|保有資格|国籍|在住|所属|会社名|企業名|スキルサマリ[ー]?|自己PR|PR|アピールポイント|強み|希望勤務|希望単価|参画時期|稼働|補足|メモ|コメント|環境|言語|OS|DB|ツール|開発環境|フレームワーク|クラウド|インフラ|ミドルウェア|その他|立場|開発規模|人数|スキル|コンピュータ言語|サーバ[ー]?OS|データベース|開発[・/]?運用ツール|業務経験|知識有り|経歴|能力指標|雇用形態|調査|テスト(?:計画)?|改修|指標|固定)$/

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

  // 右セル検索中に親からはみ出したセルに出会ったら、親から独立させる
  while (context.keyStack.length > 0) {
    const parentContainer = context.keyStack[context.keyStack.length - 1]
    // はみ出しをチェック
    if (parentContainer.colEnd <= right.col && parentContainer.rowEnd <= right.row) {
      // はみ出ている → 親から独立
      context.currentRecord = context.recordStack.pop()
      context.keyStack.pop()
    } else {
      break
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

  // 下セル検索中に親からはみ出したセルに出会ったら、親から独立させる
  while (context.keyStack.length > 0) {
    const parentContainer = context.keyStack[context.keyStack.length - 1]
    // はみ出しをチェック
    if (parentContainer.colEnd <= below.col && parentContainer.rowEnd <= below.row) {
      // はみ出ている → 親から独立
      context.currentRecord = context.recordStack.pop()
      context.keyStack.pop()
    } else {
      break
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

/** rowが小さい順、同じrowならcolが小さい順にソート */
function sortCellsByRowThenCol(cells) {
  return cells.sort((a, b) => a.row - b.row || a.col - b.col)
}

/** 指定セルの直上にあるセル（最も近い）を探す */
function findCellDirectlyAbove(cells, cell) {
  const candidates = cells.filter(c =>
    c.rowEnd < cell.row &&
    c.col <= cell.col &&
    cell.col <= c.colEnd
  )
  if (candidates.length === 0) return undefined
  return candidates.reduce((max, c) => c.rowEnd > max.rowEnd ? c : max)
}

/** 指定セルの直左にあるセル（最も近い）を探す */
function findCellDirectlyToLeft(cells, cell) {
  const candidates = cells.filter(c =>
    c.colEnd < cell.col &&
    c.row <= cell.row &&
    cell.row <= c.rowEnd
  )
  if (candidates.length === 0) return undefined
  return candidates.reduce((max, c) => c.colEnd > max.colEnd ? c : max)
}

/** 新しいメインループ：ソート済みセルを一つずつ処理 */
function processExcelWithStateMachine(cells, skillNameSet, sheetName = 'Sheet') {
  const sortedCells = sortCellsByRowThenCol(cells)
  if (sortedCells.length === 0) return { [sheetName]: {} }

  const record = { [sheetName]: {} }
  let currentRecord = record[sheetName]
  const recordStack = [record[sheetName]]
  const keyStack = []  // 親セル（SpanCell）を積む

  for (const cell of sortedCells) {
    const cellValue = cell.value.trim()
    const isKey = TAG_DICT.test(cellValue)

    if (isKey) {
      // ── 親コンテナからのはみ出し判定（スパン比較）──────────────────────
      while (keyStack.length > 0) {
        const par = keyStack[keyStack.length - 1]
        const parIsAbove = par.rowEnd < cell.row
        const parIsLeft  = par.colEnd < cell.col

        if (parIsAbove) {
          // 縦配置の親。現セルが同幅以上 → 兄弟レベル → 脱出
          if (_cs(cell) >= _cs(par)) {
            currentRecord = recordStack.pop()
            keyStack.pop()
          } else break
        } else if (parIsLeft) {
          // 横配置の親。現セルが同高以上 → 兄弟レベル → 脱出
          if (_rs(cell) >= _rs(par)) {
            currentRecord = recordStack.pop()
            keyStack.pop()
          } else break
        } else {
          break  // 親の範囲内
        }
      }

      // ── コンテナ親の検出（スパン比較あり）─────────────────────────────
      const above = findCellDirectlyAbove(sortedCells, cell)
      const aboveIsKey = above && TAG_DICT.test(above.value.trim())
      const left  = findCellDirectlyToLeft(sortedCells, cell)
      const leftIsKey  = left  && TAG_DICT.test(left.value.trim())

      // above が親 → 現セルの colSpan が above より小さい場合のみ
      const aboveIsParent = aboveIsKey && _cs(above) > _cs(cell)
      // left が親 → 現セルの rowSpan が left より小さい場合のみ
      const leftIsParent  = leftIsKey  && _rs(left)  > _rs(cell)

      let parentKey = undefined
      if (aboveIsParent && leftIsParent) {
        // 両方ある → スパンが大きい方を直接の親とする
        parentKey = (_cs(above) * _rs(above)) >= (_cs(left) * _rs(left)) ? above : left
      } else if (aboveIsParent) {
        parentKey = above
      } else if (leftIsParent) {
        parentKey = left
      }

      // ── コンテナ昇格（まだ積んでいない場合のみ）─────────────────────────
      if (parentKey) {
        const alreadyPushed = keyStack.some(k => k === parentKey)
        if (!alreadyPushed) {
          const parentKeyValue = parentKey.value.trim()
          const newContainer = {}
          currentRecord[parentKeyValue] = newContainer
          recordStack.push(currentRecord)
          keyStack.push(parentKey)
          currentRecord = newContainer
        }
      }

      // ── キー登録 ────────────────────────────────────────────────────────
      currentRecord[cellValue] = ""
    } else {
      // 非キー（値）処理

      // 左のセルをチェック（左優先）
      const left = findCellDirectlyToLeft(sortedCells, cell)
      if (left) {
        const leftKeyValue = left.value.trim()
        if (TAG_DICT.test(leftKeyValue) && currentRecord.hasOwnProperty(leftKeyValue)) {
          const key = leftKeyValue
          if (currentRecord[key] === undefined || currentRecord[key] === "") {
            currentRecord[key] = cellValue
          } else if (Array.isArray(currentRecord[key])) {
            if (cellValue !== "") {
              currentRecord[key].push(cellValue)
            }
          } else {
            if (cellValue !== "") {
              const existing = currentRecord[key]
              currentRecord[key] = [existing, cellValue]
            }
          }
          continue
        }
      }

      // 上のセルをチェック
      const above = findCellDirectlyAbove(sortedCells, cell)
      if (above) {
        const aboveKeyValue = above.value.trim()
        if (TAG_DICT.test(aboveKeyValue) && currentRecord.hasOwnProperty(aboveKeyValue)) {
          const key = aboveKeyValue
          if (currentRecord[key] === undefined || currentRecord[key] === "") {
            currentRecord[key] = cellValue
          } else if (Array.isArray(currentRecord[key])) {
            if (cellValue !== "") {
              currentRecord[key].push(cellValue)
            }
          } else {
            if (cellValue !== "") {
              const existing = currentRecord[key]
              currentRecord[key] = [existing, cellValue]
            }
          }
          continue
        }
      }
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

// ─── V2: コンテナ優先・再帰ツリー構築 ────────────────────────────────────

/**
 * processExcelWithStateMachineV2
 *
 * V1 の問題点（値の格納先ずれ・はみ出し誤判定）を解消するため、
 * 「大きいコンテナを先に検出 → 子セルだけ切り出して再帰」方式に変更。
 *
 * Phase 1: 幅広の TAG_DICT セル（スキル, 業務内容 等）をコンテナとして検出
 * Phase 2: コンテナの子セルを座標で切り出し、再帰的にツリー構築
 * Phase 3: 残りを key-value ペアとして処理
 */
function processExcelWithStateMachineV2(cells, skillNameSet, sheetName = 'Sheet') {
  const sorted = sortCellsByRowThenCol(cells)
  if (sorted.length === 0) return { [sheetName]: {} }

  const tree = _v2Build(sorted)
  return { [sheetName]: tree }
}

/**
 * 再帰ツリー構築のメインロジック。
 * cells 内からコンテナを見つけ、子を切り出して再帰。残りは KV ペア。
 */
function _v2Build(cells) {
  if (cells.length === 0) return {}

  const tags = cells.filter(c => TAG_DICT.test(c.value.trim()))

  // ── コンテナ検出 ────────────────────────────────────────────────
  const containers = _v2FindContainers(cells, tags)
  // 面積降順（外側から処理）
  containers.sort((a, b) => b.area - a.area)

  const result = {}
  const consumed = new Set()

  for (const cont of containers) {
    if (consumed.has(cont.cell)) continue
    consumed.add(cont.cell)

    const children = cells.filter(c =>
      !consumed.has(c) &&
      c.row >= cont.rowStart && c.rowEnd <= cont.rowEnd &&
      c.col >= cont.colStart && c.colEnd <= cont.colEnd
    )
    children.forEach(c => consumed.add(c))

    // ── テーブルパターン検出 ──────────────────────────────────────
    // 子セルの先頭行に TAG_DICT が複数横並び → ヘッダー行
    // その下に左端 rowSpan 大のセル → 行グループ
    const tableResult = _v2TryTable(children)
    if (tableResult) {
      result[cont.cell.value.trim()] = tableResult
      continue
    }

    const sub = _v2Build(children)
    result[cont.cell.value.trim()] = Object.keys(sub).length > 0 ? sub : ''
  }

  // ── 残りを KV ペア処理 ──────────────────────────────────────────
  const remaining = cells.filter(c => !consumed.has(c))
  _v2ProcessRows(remaining, result, cells)

  return result
}

/**
 * テーブルパターン検出。
 *
 * 条件:
 *   1. 先頭行に TAG_DICT セルが 3 つ以上横並び → 列ヘッダー行
 *   2. ヘッダー行の下に、左端で rowSpan >= 3 のセルがある → 行グループキー
 *
 * 成功時: { "グループキー値": { "列ヘッダー": "値", ... }, ... } を返す
 * 失敗時: null（テーブルパターンではない → 呼び出し元が通常の _v2Build にフォールバック）
 */
function _v2TryTable(cells) {
  if (cells.length === 0) return null

  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col)
  const firstRow = sorted[0].row

  // ── Step 1: ヘッダー行検出 ──────────────────────────────────────
  const headerCells = sorted.filter(c => c.row === firstRow)
  const headerTags = headerCells.filter(c => TAG_DICT.test(c.value.trim()))
  if (headerTags.length < 3) return null  // ヘッダーが少なすぎ → テーブルではない

  // 列ヘッダーマップ: col → { key, colEnd }
  const colHeaders = []
  for (const h of headerTags) {
    colHeaders.push({ key: h.value.trim(), col: h.col, colEnd: h.colEnd })
  }

  // ── Step 2: 行グループキー検出 ──────────────────────────────────
  // ヘッダー行の下で、左端（最小 col）かつ rowSpan >= 3 のセル
  const dataCells = sorted.filter(c => c.row > firstRow)
  if (dataCells.length === 0) return null

  const minCol = Math.min(...dataCells.map(c => c.col))
  const groupKeys = dataCells.filter(c =>
    c.col === minCol && _rs(c) >= 3
  ).sort((a, b) => a.row - b.row)

  if (groupKeys.length === 0) return null  // 行グループなし → テーブルではない

  // ── Step 2.5: 繰り返しヘッダパターン検出 ────────────────────────
  // groupKeys に "No." が含まれる場合、メタ（No.）＋コンテンツ（番号）のペアで処理
  const noKeys = groupKeys.filter(gk => /^No\.?$/i.test(gk.value.trim()))
  if (noKeys.length > 0) {
    return _v2ParseRepeatingBlocks(sorted, groupKeys, noKeys, minCol, firstRow)
  }

  // ── Step 3: 各行グループをパース（D.U 形式: 固定ヘッダー行 + 行グループ）──
  const DATE_RE = /^\d{4}[\/\-年]\d{1,2}/
  const DUR_RE  = /^\d+年\d+ヶ月$|^\d+ヶ月$|^\d+年$/
  const DASH_RE = /^[-ー－〜～]$/
  const tableResult = {}

  for (const gk of groupKeys) {
    const groupLabel = gk.value.trim()
    const groupRowStart = gk.row
    const groupRowEnd = gk.rowEnd

    // このグループ内のセル（グループキー自身を除く）
    const groupCells = dataCells.filter(c =>
      c !== gk &&
      c.row >= groupRowStart && c.rowEnd <= groupRowEnd
    )

    // 列ヘッダーに基づいて値を振り分け → フラットに groupRecord に格納
    const groupRecord = {}
    const consumed = new Set()

    for (const ch of colHeaders) {
      if (ch.col === minCol) continue  // グループキー列はスキップ（No. 等）

      // この列ヘッダーの col 範囲内にあるセルを収集
      const colCells = groupCells.filter(c =>
        !consumed.has(c) && c.col >= ch.col && c.col <= ch.colEnd
      ).sort((a, b) => a.row - b.row || a.col - b.col)
      if (colCells.length === 0) continue

      // ── 期間列: 日付 + ダッシュ + 期間を結合 ──────────────────
      if (/^期間/.test(ch.key)) {
        const dates = []
        let dur = ''
        const otherLabels = []

        for (const cc of colCells) {
          const cv = cc.value.trim()
          consumed.add(cc)
          if (DATE_RE.test(cv))      dates.push(cv)
          else if (DUR_RE.test(cv))  dur = cv
          else if (DASH_RE.test(cv)) { /* skip */ }
          else if (TAG_DICT.test(cv)) otherLabels.push(cc)  // 備考 等
          else {
            // 長テキスト（【言語】ブロック等）→ 直前のラベルに紐付け
            if (otherLabels.length > 0) {
              const lbl = otherLabels[otherLabels.length - 1].value.trim()
              _v2Append(groupRecord, lbl, cv)
            }
          }
        }
        // 期間文字列を組み立て
        if (dates.length >= 2 && dur)      groupRecord['期間'] = `${dates[0]}〜${dates[dates.length - 1]}（${dur}）`
        else if (dates.length >= 2)        groupRecord['期間'] = `${dates[0]}〜${dates[dates.length - 1]}`
        else if (dates.length === 1 && dur) groupRecord['期間'] = `${dates[0]}〜（${dur}）`
        else if (dur)                       groupRecord['期間'] = dur
        else if (dates.length >= 1)        groupRecord['期間'] = dates.join('〜')
        // 備考等のラベルだけ残ってる場合は空で登録
        for (const lbl of otherLabels) {
          const lk = lbl.value.trim()
          if (!(lk in groupRecord)) groupRecord[lk] = ''
        }
        continue
      }

      // ── 内容列等: ラベル→値ペアをフラットに展開 ─────────────────
      // テーブル内ではラベルの右隣は TAG_DICT でも値として扱う
      for (let ci = 0; ci < colCells.length; ci++) {
        const cc = colCells[ci]
        if (consumed.has(cc)) continue
        const cv = cc.value.trim()

        if (TAG_DICT.test(cv)) {
          consumed.add(cc)
          // 右隣を値として取る（TAG_DICT でも OK — PM, PMO 等が値になるケース）
          const rightVal = groupCells.find(rc =>
            !consumed.has(rc) &&
            rc.row === cc.row && rc.col > cc.colEnd
          )
          if (rightVal) {
            consumed.add(rightVal)
            groupRecord[cv] = rightVal.value.trim()
          } else {
            // 下にある非TAG値を探す（担当業務→長文 等）
            const belowVal = groupCells.find(bc =>
              !consumed.has(bc) &&
              bc.row > cc.rowEnd &&
              bc.col >= cc.col && bc.col <= cc.colEnd &&
              !TAG_DICT.test(bc.value.trim())
            )
            if (belowVal) {
              consumed.add(belowVal)
              groupRecord[cv] = belowVal.value.trim()
            } else {
              if (!(cv in groupRecord)) groupRecord[cv] = ''
            }
          }
        } else {
          consumed.add(cc)
          // 孤立値 → 列ヘッダー名に紐付け
          if (!(ch.key in groupRecord)) {
            groupRecord[ch.key] = cv
          } else {
            _v2Append(groupRecord, ch.key, cv)
          }
        }
      }
    }

    // ── フェーズ評価等: ヘッダー col 範囲のセル（◎/○/◇）を紐付け ──
    for (const ch of colHeaders) {
      if (ch.key in groupRecord) continue
      const evalCell = groupCells.find(c =>
        !consumed.has(c) &&
        c.col >= ch.col && c.colEnd <= ch.colEnd && c.value.trim()
      )
      if (evalCell) {
        consumed.add(evalCell)
        groupRecord[ch.key] = evalCell.value.trim()
      }
    }

    if (Object.keys(groupRecord).length > 0) {
      tableResult[groupLabel] = groupRecord
    }
  }

  return Object.keys(tableResult).length > 0 ? tableResult : null
}

/**
 * 繰り返しヘッダパターン: No. メタブロック + 番号コンテンツブロックのペアを処理。
 *
 * T.K 形式:
 *   [No.](rs5) | 期間 | 雇用形態→値 | 備考→大セル | 調査(rs10) | ...
 *              | date | 規模→値      |             |
 *              | dur  | 役割→値      |             |
 *   [1](rs19)  | 案件名→値          |             | ●(rs13)    | ...
 *              | 長文description    |             |
 */
function _v2ParseRepeatingBlocks(sorted, groupKeys, noKeys, minCol, firstRow) {
  const noSet = new Set(noKeys)
  const DATE_RE = /^\d{4}[\/\-年]\d{1,2}/
  const SERIAL_RE = /^\d{5}$/
  const DUR_RE  = /^\d+年\d+ヶ月$|^\d+ヶ月$|^\d+年$/
  const DASH_RE = /^[-ー－〜～]$/
  const PHASE_MARKER_RE = /^[●◎○◇△▲×✕✓☆]+$/

  // Excel serial date → "YYYY年M月" 変換
  function serialToYM(serial) {
    const d = new Date((serial - 25569) * 86400000)
    return `${d.getFullYear()}年${d.getMonth() + 1}月`
  }

  // ── ヘッダ行の No. も含めてペアリング ──────────────────────────
  // ヘッダ行に No. がある場合（firstRow = No. の先頭行）、groupKeys に含まれないので追加
  const allKeys = [...groupKeys]
  const headerNoCell = sorted.find(c =>
    c.row === firstRow && c.col <= minCol + 1 &&
    /^No\.?$/i.test(c.value.trim()) && _rs(c) >= 3
  )
  if (headerNoCell) {
    allKeys.unshift(headerNoCell)
    noSet.add(headerNoCell)
  }

  const pairs = []
  const processed = new Set()
  for (let i = 0; i < allKeys.length; i++) {
    if (processed.has(allKeys[i])) continue
    if (noSet.has(allKeys[i])) {
      processed.add(allKeys[i])
      let content = null
      for (let j = i + 1; j < allKeys.length; j++) {
        if (!noSet.has(allKeys[j]) && !processed.has(allKeys[j])) {
          content = allKeys[j]
          processed.add(content)
          break
        }
      }
      pairs.push({ meta: allKeys[i], content: content })
    }
  }

  if (pairs.length === 0) return null

  const tableResult = {}

  for (const pair of pairs) {
    const projectNum = pair.content ? pair.content.value.trim() : String(pairs.indexOf(pair) + 1)
    const record = {}
    const consumed = new Set()

    // ── メタブロック処理（No. の行範囲内のセル）──────────────────
    const metaRowStart = pair.meta.row
    const metaRowEnd = pair.meta.rowEnd
    // ヘッダー行 = No. の先頭行（No. 自身と同じ行）に含まれるセルも対象
    // firstRow の行は No. ブロックの一部（No. が先頭行に始まる）
    const metaAllCells = sorted.filter(c =>
      c !== pair.meta &&
      c.row >= metaRowStart && c.row <= metaRowEnd &&
      c.col > minCol
    ).sort((a, b) => a.row - b.row || a.col - b.col)

    // 日付・期間を収集
    const dates = []
    let dur = ''

    // 行ごとにラベル→値ペアを抽出
    for (const mc of metaAllCells) {
      if (consumed.has(mc)) continue
      const mv = mc.value.trim()

      // Excel serial date
      if (SERIAL_RE.test(mv)) {
        consumed.add(mc)
        dates.push(serialToYM(Number(mv)))
        continue
      }
      if (DATE_RE.test(mv)) { consumed.add(mc); dates.push(mv); continue }
      if (DUR_RE.test(mv))  { consumed.add(mc); dur = mv; continue }
      if (DASH_RE.test(mv)) { consumed.add(mc); continue }
      if (PHASE_MARKER_RE.test(mv)) continue  // フェーズマーカは後で処理

      // フェーズヘッダ（rs>=5 の TAG_DICT: 調査, 基本設計, 製造 等）はスキップ → 後で処理
      if (TAG_DICT.test(mv) && _rs(mc) >= 5) continue
      // 期間ラベルはスキップ（日付は SERIAL_RE/DATE_RE/DUR_RE で別途収集）
      if (/^期間/.test(mv)) { consumed.add(mc); continue }

      if (TAG_DICT.test(mv)) {
        consumed.add(mc)
        // 右隣に値があるか（同行〜rowEnd、近接 col、TAG/フェーズヘッダでないもの）
        const rightVal = metaAllCells.find(rc =>
          !consumed.has(rc) &&
          rc.row >= mc.row && rc.row <= mc.rowEnd &&
          rc.col >= mc.colEnd + 1 && rc.col <= mc.colEnd + 5 &&
          !PHASE_MARKER_RE.test(rc.value.trim()) &&
          !TAG_DICT.test(rc.value.trim()) &&
          _rs(rc) < 5  // フェーズヘッダを除外
        )
        if (rightVal) {
          consumed.add(rightVal)
          record[mv] = rightVal.value.trim()
        } else {
          // 右に値がない → 下方のセルを探す（備考 → 大セル等）
          const belowVal = metaAllCells.find(bc =>
            !consumed.has(bc) &&
            bc.row > mc.rowEnd &&
            bc.col >= mc.col && bc.col <= mc.colEnd + 2 &&
            !TAG_DICT.test(bc.value.trim()) && !PHASE_MARKER_RE.test(bc.value.trim())
          )
          if (belowVal) {
            consumed.add(belowVal)
            record[mv] = belowVal.value.trim()
          }
        }
        continue
      }

      // 非TAG の長テキスト → 上方のラベルに紐付け
      if (mv.length > 20 && !consumed.has(mc)) {
        consumed.add(mc)
        const aboveLabel = metaAllCells.find(lc =>
          lc.rowEnd < mc.row &&
          lc.col >= mc.col - 2 && lc.col <= mc.col + 2 &&
          TAG_DICT.test(lc.value.trim())
        )
        if (aboveLabel && !(aboveLabel.value.trim() in record)) {
          record[aboveLabel.value.trim()] = mv
        }
      }
    }

    // 期間を組み立て
    if (dates.length >= 2 && dur)       record['期間'] = `${dates[0]}〜${dates[1]}（${dur}）`
    else if (dates.length >= 2)         record['期間'] = `${dates[0]}〜${dates[1]}`
    else if (dates.length === 1 && dur) record['期間'] = `${dates[0]}（${dur}）`
    else if (dur)                        record['期間'] = dur
    else if (dates.length >= 1)         record['期間'] = dates.join('〜')

    // ── コンテンツブロック処理（番号セルの行範囲）────────────────
    if (pair.content) {
      const contentCells = sorted.filter(c =>
        c !== pair.content &&
        c.row >= pair.content.row && c.row <= pair.content.rowEnd &&
        c.col > minCol
      ).sort((a, b) => a.row - b.row || a.col - b.col)

      for (const cc of contentCells) {
        if (consumed.has(cc)) continue
        const cv = cc.value.trim()
        if (PHASE_MARKER_RE.test(cv)) continue  // フェーズ●は後で

        if (TAG_DICT.test(cv)) {
          consumed.add(cc)
          // 右隣を値として取る
          const rightVal = contentCells.find(rc =>
            !consumed.has(rc) &&
            rc.row >= cc.row && rc.row <= cc.rowEnd &&
            rc.col >= cc.colEnd + 1
          )
          if (rightVal) {
            consumed.add(rightVal)
            _v2Append(record, cv, rightVal.value.trim())
          } else {
            // 下の非TAG値
            const belowVal = contentCells.find(bc =>
              !consumed.has(bc) &&
              bc.row > cc.rowEnd &&
              bc.col >= cc.col && bc.colEnd <= (cc.colEnd + 10) &&
              !TAG_DICT.test(bc.value.trim()) && !PHASE_MARKER_RE.test(bc.value.trim())
            )
            if (belowVal) {
              consumed.add(belowVal)
              _v2Append(record, cv, belowVal.value.trim())
            }
          }
        } else if (cv.length > 30) {
          // 長文 → 「内容」として追記
          consumed.add(cc)
          _v2Append(record, '内容', cv)
        }
      }
    }

    // ── フェーズ列の収集 ──────────────────────────────────────────
    // メタブロック内で rs が大きく縦に伸びる TAG_DICT セルがフェーズヘッダ
    const phaseHeaders = metaAllCells.filter(c =>
      !consumed.has(c) && TAG_DICT.test(c.value.trim()) && _rs(c) >= 5
    )
    if (phaseHeaders.length > 0 && pair.content) {
      const phases = {}
      for (const ph of phaseHeaders) {
        // 同じ col でコンテンツブロック内の●マーカを探す
        const marker = sorted.find(m =>
          m.col === ph.col &&
          m.row >= pair.content.row && m.row <= pair.content.rowEnd &&
          PHASE_MARKER_RE.test(m.value.trim())
        )
        if (marker) {
          phases[ph.value.trim()] = marker.value.trim()
        }
      }
      if (Object.keys(phases).length > 0) {
        record['担当工程'] = phases
      }
    }

    if (Object.keys(record).length > 0) {
      tableResult[projectNum] = record
    }
  }

  return Object.keys(tableResult).length > 0 ? tableResult : null
}

/**
 * コンテナ検出。
 * TAG_DICT セルのうち、自分の col 範囲の下に colSpan が小さい TAG_DICT セルがあるものをコンテナとみなす。
 * rowSpan > 1 のカテゴリセル（コンピュータ言語 r2×c7 等）も対象。
 */
function _v2FindContainers(allCells, tagCells) {
  const containers = []

  for (const tc of tagCells) {
    const cs = _cs(tc)
    if (cs < 3) continue  // 狭すぎるものはスキップ

    // 自分より下にあり、自分の col 範囲内で、colSpan が小さい TAG_DICT セル
    const childTags = tagCells.filter(ct =>
      ct !== tc &&
      ct.row > tc.rowEnd &&
      ct.col >= tc.col &&
      ct.colEnd <= tc.colEnd &&
      _cs(ct) < cs
    )
    if (childTags.length === 0) continue

    const childRowStart = tc.rowEnd + 1

    // 子領域の rowEnd: col 範囲内のセルの最大 rowEnd
    const cellsBelow = allCells.filter(c =>
      c.col >= tc.col && c.colEnd <= tc.colEnd && c.row >= childRowStart
    )
    if (cellsBelow.length === 0) continue
    let childRowEnd = Math.max(...cellsBelow.map(c => c.rowEnd))

    // 兄弟コンテナ（同じ col・同じ以上の幅）で打ち切り
    for (const other of tagCells) {
      if (other === tc || other.row <= tc.rowEnd) continue
      if (other.col <= tc.col && _cs(other) >= cs && other.row <= childRowEnd) {
        childRowEnd = Math.min(childRowEnd, other.row - 1)
      }
    }

    if (childRowEnd < childRowStart) continue

    containers.push({
      cell: tc,
      rowStart: childRowStart,
      rowEnd: childRowEnd,
      colStart: tc.col,
      colEnd: tc.colEnd,
      area: cs * (childRowEnd - tc.row + 1),
    })
  }

  return containers
}

/**
 * 残りセルを行単位で処理。
 *
 * パターン検出:
 *   RowGroup パターン — rowSpan>=2 のカテゴリ + 同行の「業務経験」+値、次行の「知識有り」+値
 *   KV パターン       — TAG_DICT キー + 右隣の値
 *   Orphan            — 上セルのキーに紐付け
 */
function _v2ProcessRows(cells, result, allCells) {
  if (cells.length === 0) return

  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col)
  const consumed = new Set()

  // ── RowGroup パターン検出 ────────────────────────────────────────
  // rowSpan >= 2 の TAG_DICT セル（カテゴリ）を探す
  const rowGroupHeaders = sorted.filter(c =>
    TAG_DICT.test(c.value.trim()) && _rs(c) >= 2
  )

  for (const cat of rowGroupHeaders) {
    if (consumed.has(cat)) continue
    consumed.add(cat)

    const catKey = cat.value.trim()
    const sub = {}

    // カテゴリの row〜rowEnd の各行で、カテゴリの colEnd より右にあるセルを収集
    for (let r = cat.row; r <= cat.rowEnd; r++) {
      const rowCells = sorted.filter(c =>
        !consumed.has(c) && c.row === r && c.col > cat.colEnd
      ).sort((a, b) => a.col - b.col)

      // パターン: [TAG_DICT ラベル(業務経験/知識有り)] [値セル]
      let i = 0
      while (i < rowCells.length) {
        const lbl = rowCells[i]
        if (TAG_DICT.test(lbl.value.trim())) {
          consumed.add(lbl)
          const lblKey = lbl.value.trim()
          // 直右の非TAG値
          if (i + 1 < rowCells.length && !TAG_DICT.test(rowCells[i + 1].value.trim())) {
            const val = rowCells[i + 1]
            consumed.add(val)
            sub[lblKey] = val.value.trim()
            i += 2
          } else {
            if (!(lblKey in sub)) sub[lblKey] = ''
            i++
          }
        } else {
          // 非TAGの孤立値 → 最後に登録されたラベルに追記
          consumed.add(rowCells[i])
          i++
        }
      }
    }

    result[catKey] = Object.keys(sub).length > 0 ? sub : ''
  }

  // ── 通常 KV ペア処理 ────────────────────────────────────────────
  // 行ごとにグループ化
  const rem = sorted.filter(c => !consumed.has(c))
  const byRow = new Map()
  for (const c of rem) {
    if (!byRow.has(c.row)) byRow.set(c.row, [])
    byRow.get(c.row).push(c)
  }
  const rowNums = [...byRow.keys()].sort((a, b) => a - b)

  for (const rn of rowNums) {
    const rowCells = (byRow.get(rn) || []).filter(c => !consumed.has(c))
    if (rowCells.length === 0) continue

    let i = 0
    while (i < rowCells.length) {
      const c = rowCells[i]
      const cv = c.value.trim()

      if (TAG_DICT.test(cv)) {
        consumed.add(c)
        // 右に値があるか
        if (i + 1 < rowCells.length && !TAG_DICT.test(rowCells[i + 1].value.trim())) {
          const val = rowCells[i + 1]
          consumed.add(val)
          _v2Append(result, cv, val.value.trim())
          i += 2
        } else {
          if (!(cv in result)) result[cv] = ''
          i++
        }
      } else {
        // 孤立値 → 上のキーに紐付け
        consumed.add(c)
        const above = findCellDirectlyAbove(allCells, c)
        if (above && TAG_DICT.test(above.value.trim())) {
          _v2Append(result, above.value.trim(), cv)
        }
        i++
      }
    }
  }
}

function _v2Append(record, key, value) {
  if (!value) return
  if (!(key in record)) { record[key] = value; return }
  if (record[key] === undefined || record[key] === '') {
    record[key] = value
  } else if (Array.isArray(record[key])) {
    record[key].push(value)
  } else {
    record[key] = [record[key], value]
  }
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

  // セルダンプ（上位50件）
  console.log('\n--- SpanCell サンプル (上位50件) ---')
  for (const c of cells.slice(0, 50)) {
    const rowSpan = c.rowEnd - c.row + 1
    const colSpan = c.colEnd - c.col + 1
    const span = (rowSpan > 1 || colSpan > 1) ? ` [r${rowSpan}×c${colSpan}]` : ''
    console.log(`  (${c.row},${c.col})${span}: ${JSON.stringify(c.value.slice(0, 80))}`)
  }

  // セルをソート
  const sortedCells = sortCellsByRowThenCol(cells)

  // ═══ V1 ═══
  console.log('\n' + '─'.repeat(40))
  console.log('V1 (processExcelWithStateMachine)')
  console.log('─'.repeat(40))
  const v1Output = processExcelWithStateMachine(sortedCells, skillNameSet, sheetName)

  const v1Skill = v1Output[sheetName]?.スキル
  if (v1Skill) {
    console.log('\n[V1] スキルセクション:')
    console.log(JSON.stringify(v1Skill, null, 2))
  }

  console.log('\n[V1] 全体出力:')
  console.log(JSON.stringify(v1Output, null, 2).slice(0, 5000))

  // ═══ V2 ═══
  console.log('\n' + '─'.repeat(40))
  console.log('V2 (processExcelWithStateMachineV2)')
  console.log('─'.repeat(40))
  const v2Output = processExcelWithStateMachineV2(sortedCells, skillNameSet, sheetName)

  const v2Skill = v2Output[sheetName]?.スキル
  if (v2Skill) {
    console.log('\n[V2] スキルセクション:')
    console.log(JSON.stringify(v2Skill, null, 2))
  }

  console.log('\n[V2] 全体出力:')
  console.log(JSON.stringify(v2Output, null, 2).slice(0, 5000))

  // ═══ 比較サマリ ═══
  console.log('\n' + '─'.repeat(40))
  console.log('比較サマリ')
  console.log('─'.repeat(40))
  const v1Keys = v1Skill ? Object.keys(v1Skill) : []
  const v2Keys = v2Skill ? Object.keys(v2Skill) : []
  console.log(`[V1] スキル直下キー数: ${v1Keys.length}  ${v1Keys.join(', ')}`)
  console.log(`[V2] スキル直下キー数: ${v2Keys.length}  ${v2Keys.join(', ')}`)

  // V1 で漏れた値をチェック
  if (v1Skill && typeof v1Skill === 'object') {
    const leaked = Object.entries(v1Skill).filter(([k, v]) => typeof v === 'string' && v.length > 0 && !k.includes('言語') && !k.includes('OS') && !k.includes('ツール') && !k.includes('その他') && !k.includes('データ'))
    if (leaked.length > 0) {
      console.log(`[V1] ⚠ スキル直下に漏れた値: ${leaked.map(([k,v]) => `${k}=${JSON.stringify(v).slice(0,40)}`).join(', ')}`)
    }
  }
  if (v2Skill && typeof v2Skill === 'object') {
    const leaked = Object.entries(v2Skill).filter(([k, v]) => typeof v === 'string' && v.length > 0 && !k.includes('言語') && !k.includes('OS') && !k.includes('ツール') && !k.includes('その他') && !k.includes('データ'))
    if (leaked.length > 0) {
      console.log(`[V2] ⚠ スキル直下に漏れた値: ${leaked.map(([k,v]) => `${k}=${JSON.stringify(v).slice(0,40)}`).join(', ')}`)
    }
  }
}
