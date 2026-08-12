#!/usr/bin/env node
/**
 * probe_skillyears.mjs — 1人の経歴書Excelを本番と同じ経路に通し、結果を並べて比較する
 *
 * experience_years が実態とズレるときに、どの抽出方式が勝ったか・
 * _dateSpanMonths / _totalProjectMonths が取れているかをデプロイなしで確認する。
 *
 * ※ 2026-08-12 まで、このツールは本番と違う入力を渡していた。
 *    - Unified に sheet_to_json の出力（結合セル未展開・数値セルが number のまま）を渡していた。
 *      本番は worksheetToGrid（結合セルを空文字で埋めて列位置を保つ・全て文字列）
 *    - Cells に {rowSpan, colSpan} のセルを渡していた。
 *      本番の worksheetToCells は {rowEnd, colEnd}。プロパティ名が違うので常に空を返していた
 *    そのため「ローカルでは _dateSpanMonths が出るのに Edge Function では付かない」という
 *    存在しない差異を追いかけることになった。本番と同じ関数を使うよう直してある。
 *
 * 再現していないもの: 視覚エンジン（tryVisualSkillExtraction / extractSkillYearsVisualProject）。
 * 罫線・色の読み取りにファイルのバイト列が要るため、ここでは grid と cells の比較までを見る。
 *
 * 使い方:
 *   node scripts/probe_skillyears.mjs <candidate_id>
 *   node scripts/probe_skillyears.mjs <candidate_id> --skills   # スキル別月数を全部出す
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'
import {
  extractSkillYearsUnified,
  extractSkillYearsFromCells,
  extractSkillYearsFromSheetData,
  filterSkillYears,
  scoreSkillQuality,
  worksheetToGrid,
  worksheetToCells,
} from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }

const id = process.argv[2]
const SHOW_SKILLS = process.argv.includes('--skills')
if (!id) { console.log('使い方: node scripts/probe_skillyears.mjs <candidate_id> [--skills]'); process.exit(0) }

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=name,experience_years,resume_url,age:raw_profile->age,sy:raw_profile->skillYears`, { headers })
const [c] = await res.json()
if (!c) { console.log('見つかりません'); process.exit(0) }
console.log(`${c.name}  DB経験年数=${c.experience_years ?? '—'}年  年齢=${c.age ?? '—'}`)
const dbMeta = Object.entries(c.sy ?? {}).filter(([k]) => k.startsWith('_'))
console.log(`DB上のskillYears: スキル${Object.keys(c.sy ?? {}).filter(k => !k.startsWith('_')).length}件  ${dbMeta.map(([k, v]) => `${k}=${v}`).join(' ') || '内部キーなし'}`)
console.log(`${c.resume_url}\n`)

if (!/\.xlsx?$/i.test(String(c.resume_url).split('?')[0])) {
  console.log('Excel 以外の経歴書です（このツールは xlsx/xls 専用）'); process.exit(0)
}

// 読み込みオプションも本番に合わせる（index.ts:7299）。cellDates の有無で
// 日付書式のセルが Date になるかテキストのままかが変わり、抽出結果が別物になる
const wb = XLSX.read(new Uint8Array(await (await fetch(c.resume_url)).arrayBuffer()),
  { type: 'array', cellDates: true })

const show = (label, obj, score) => {
  if (!obj || Object.keys(obj).length === 0) { console.log(`  ${label}: (空)`); return }
  const meta = Object.entries(obj).filter(([k]) => k.startsWith('_'))
  const skills = Object.entries(obj).filter(([k]) => !k.startsWith('_'))
  const maxM = Math.max(0, ...skills.map(([, v]) => v))
  const s = score == null ? '' : ` 品質スコア=${score}`
  console.log(`  ${label}: スキル${skills.length}件 最長${maxM}ヶ月(${(maxM / 12).toFixed(1)}年)${s}  ${meta.map(([k, v]) => `${k}=${v}`).join(' ') || '内部キーなし'}`)
  if (SHOW_SKILLS) {
    for (const [k, v] of skills.sort((a, b) => b[1] - a[1])) console.log(`      ${String(k).padEnd(24)} ${v}ヶ月`)
  }
}

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name]
  // 本番（inbound-email）と同じ入力の作り方
  const grid = worksheetToGrid(ws)
  const cells = worksheetToCells(ws)
  console.log(`=== シート「${name}」 grid ${grid.length}行 / cells ${cells.length}個 ===`)

  let syGrid = {}, syCells = {}
  try { syGrid = extractSkillYearsUnified(grid) } catch (e) { console.log(`  Unified: ERR ${e.message}`) }
  try { syCells = filterSkillYears(extractSkillYearsFromCells(cells)) } catch (e) { console.log(`  Cells: ERR ${e.message}`) }

  const countGrid = scoreSkillQuality(syGrid)
  const countCells = scoreSkillQuality(syCells)
  show('grid  (Unified)     ', syGrid, countGrid)
  show('cells (SpanCell)    ', syCells, countCells)

  if (countGrid > 0 || countCells > 0) {
    // 本番の勝者決定（視覚エンジンを除く）。同点は cells 優先＝空間構造が正確
    let winner = countCells >= countGrid ? syCells : syGrid
    const winnerName = countCells >= countGrid ? 'cells' : 'grid'
    winner = { ...winner }
    // cells 側の内部キーは常に持ち越す（grid にはこの情報がない）
    if (syCells['_totalProjectMonths'] && !winner['_totalProjectMonths']) winner['_totalProjectMonths'] = syCells['_totalProjectMonths']
    if (syCells['_dateSpanMonths'] && !winner['_dateSpanMonths']) winner['_dateSpanMonths'] = syCells['_dateSpanMonths']
    show(`勝者 (${winnerName})`.padEnd(21), filterSkillYears(winner))
  } else {
    console.log('  勝者: なし（本番ではこの後フォールバックに落ちる）')
  }

  // 参考: 名簿シート用の別経路。本人の経歴書シートでは本番は使わない
  try {
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
    show('参考:SheetData(名簿用)', extractSkillYearsFromSheetData(data))
  } catch (e) { console.log(`  参考:SheetData: ERR ${e.message}`) }
  console.log('')
}
