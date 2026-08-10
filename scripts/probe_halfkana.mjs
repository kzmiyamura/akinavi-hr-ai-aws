#!/usr/bin/env node
// probe_halfkana.mjs — 「半角カナのヘッダーが原因でスキルが0件になる」仮説の検証
//
// 本番と同じ worksheetToGrid → extractSkillYears* を、
//   ① そのまま
//   ② 半角カナだけを全角化したグリッド
// の2通りで実行して差を見る。②で取れるなら原因は半角カナで確定する。
//
// 全角英数（ＳａｌｅｓＦｏｒｃｅ等）は触らない。NFKC を半角カナの連続だけに当てることで、
// 「半角カナが原因か」を他の正規化から切り離して測る。
//
// 使い方: node scripts/probe_halfkana.mjs [ファイル名...]（省略時は testData/excel 全件）
import { readdirSync } from 'fs'
import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  extractSkillYearsFromSheetData,
  extractSkillYearsUnified,
  worksheetToGrid,
} from './_extractors.gen.mjs'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testData/excel')
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => /\.(xlsx?|xls)$/i.test(f)).sort()

/** 半角カナの連続だけを全角化（ﾃﾞ→デ の濁点結合も NFKC が行う） */
const halfKanaToFull = (s) => String(s ?? '').replace(/[｡-ﾟ]+/g, (m) => m.normalize('NFKC'))

const countSkills = (sy) => Object.keys(sy ?? {}).filter((k) => !k.startsWith('_')).length

/** 本番と同じ順序で抽出（FromSheetData → 取れなければ Unified） */
function extract(grid) {
  const a = extractSkillYearsFromSheetData(grid)
  if (countSkills(a)) return a
  return extractSkillYearsUnified(grid) ?? {}
}

console.log('ファイル        シート                    現状  半角カナ全角化後  差')
console.log('-'.repeat(78))
let improved = 0, total = 0
for (const file of files) {
  let wb
  try { wb = XLSX.readFile(join(dir, file), { cellDates: true }) } catch { continue }
  for (const sn of wb.SheetNames) {
    const grid = worksheetToGrid(wb.Sheets[sn])
    if (!grid?.length) continue
    const before = countSkills(extract(grid))
    const after = countSkills(extract(grid.map((row) => row.map(halfKanaToFull))))
    if (before === 0 && after === 0) continue     // 変化なし・両方ゼロは省略
    total++
    if (after > before) improved++
    const mark = after > before ? ` ★+${after - before}` : (after < before ? ` ▼${after - before}` : '')
    console.log(`${file.padEnd(15)} ${sn.slice(0, 24).padEnd(25)} ${String(before).padStart(4)}  ${String(after).padStart(14)}${mark}`)
  }
}
console.log(`\n改善したシート: ${improved} / 比較対象 ${total}`)
