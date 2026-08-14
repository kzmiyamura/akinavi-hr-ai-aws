#!/usr/bin/env node
// test_llm_sheet_selection.mjs — AI経路のシート選定の回帰テスト（AI呼び出しゼロ・egress ゼロ）
//
// llm_extract/lib.mjs の buildGridInput は「どのシートを Haiku に渡すか」を決める純関数。
// ここが外れると *静かに* 壊れる:
//   ・日付セル0件 → null を返して**経歴書をAIに渡さない**（regex は読めているので気づけない）
//   ・記入例シートを選ぶ → **他人のサンプル記入を本人の経歴として転記する**
// Excel Golden は regex 経路（_extractors.gen.mjs）の回帰なので、ここは守ってくれない。
//
// 実行: node scripts/test_llm_sheet_selection.mjs
//       node scripts/test_llm_sheet_selection.mjs --update-golden   # 実ファイル分の期待値を更新
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import XLSX from 'xlsx'
import { buildGridInput } from './llm_extract/lib.mjs'
import { CASES } from './testData/synthetic_resumes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UPDATE = process.argv.includes('--update-golden')
let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (JSON.stringify(got) === JSON.stringify(expect)) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)}\n    exp=${JSON.stringify(expect)}`) }
}

// ── 合成ケース（常に手元にある・PIIなし）──
// --real-only は「変更前の旧コードで実ファイルの期待値だけ作る」ためのもの
// （旧 buildGridInput は Buffer を受け取れず合成ケースが動かない）
console.log('■ 合成ケース')
for (const c of (process.argv.includes('--real-only') ? [] : CASES)) {
  const buf = XLSX.write(c.wb(), { type: 'buffer', bookType: 'xlsx' })
  const grid = buildGridInput(buf)
  const label = c.expectSheet === null ? '読めない（null）を返す' : `シート「${c.expectSheet}」を選ぶ`
  t(`${c.name} → ${label}`, grid?.sheet ?? null, c.expectSheet)
  if (grid && c.expectSheet) t(`${c.name} → 行が取れている`, grid.rows.length > 0, true)
}

// ── 実ファイル（testData/excel・PIIのため git 管理外。無ければスキップ）──
// 「変更でシート選定が変わっていないか」だけを見る。中身は見ない
const dir = join(__dirname, 'testData/excel')
const goldenPath = join(__dirname, 'testData/llm_sheet_golden.json')
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.xlsx?$/i.test(f)).sort() : []
console.log(`\n■ 実ファイル ${files.length}件${files.length ? '' : '（testData/excel が空。download_failing_excels.mjs で取得）'}`)
const actual = {}
for (const f of files) {
  // 実ファイルはパスで渡す（変更前の旧コードでも同じ入力になるようにするため）
  const grid = buildGridInput(join(dir, f))
  actual[f] = grid ? { sheet: grid.sheet, dateCells: grid.dateCells, rows: grid.rows.length } : null
}
if (UPDATE) {
  writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n')
  console.log(`  期待値を更新しました: ${goldenPath}`)
} else if (existsSync(goldenPath)) {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
  for (const f of Object.keys(golden)) t(`${f} のシート選定`, actual[f] ?? null, golden[f])
  for (const f of files) if (!(f in golden)) console.log(`  （期待値なし・新規: ${f} → ${JSON.stringify(actual[f])}）`)
} else {
  console.log('  期待値ファイルが無い。--update-golden で作成する')
}

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
