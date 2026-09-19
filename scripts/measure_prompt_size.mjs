#!/usr/bin/env node
/**
 * 経歴書1件をAIに渡すとき、実際に何文字送っているかをローカル控えで測る。
 *
 * 経歴書の解析は実測 114秒/件（llm_shadow 直近7日 avg_sec）で、AI校正の所要時間の
 * 大半を占める。時間もトークンも入力長でほぼ決まるので、**何が長さを作っているか**を
 * 先に数える。推測でプロンプトを削ると取りこぼしに化けるため、分布を見てから決める。
 *
 * 本番を一切引かない（egress ゼロ）。
 *
 *   node scripts/measure_prompt_size.mjs [--dir D:\akinavi-archive\mail] [--days 2] [--limit 200]
 */
import fs from 'fs'
import path from 'path'
import { buildGridInput, buildTextGridInput } from './llm_extract/lib.mjs'
import { TRANSCRIBE_RULES, TRANSCRIBE_RULES_TEXT } from './llm_extract/prompts.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROOT = argOf('--dir', 'D:\\akinavi-archive\\mail')
const DAYS = Number(argOf('--days', '2'))
const LIMIT = Number(argOf('--limit', '200'))

const since = new Date(Date.now() - DAYS * 86400_000)
const dayDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => new Date(`${d.name}T23:59:59Z`) >= since)
  .map((d) => d.name).sort()

/** 対象ファイルを集める（xlsx系のみ。docx/pdf は textract が別依存なので今回は除く） */
const targets = []
for (const day of dayDirs) {
  for (const m of fs.readdirSync(path.join(ROOT, day), { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const dir = path.join(ROOT, day, m.name)
    for (const f of fs.readdirSync(dir)) {
      if (/\.(xlsx?|xlsm)$/i.test(f)) targets.push(path.join(dir, f))
      if (targets.length >= LIMIT) break
    }
    if (targets.length >= LIMIT) break
  }
  if (targets.length >= LIMIT) break
}

const sizes = []
let failed = 0, noGrid = 0
for (const fp of targets) {
  let grid
  try { grid = buildGridInput(fp) } catch { failed++; continue }
  if (!grid) { noGrid++; continue }
  const body = JSON.stringify(grid)
  // 空セルがどれだけ場所を取っているか（グリッドは矩形なので末尾が空で埋まる）
  const emptyCells = grid.rows.reduce((a, r) => a + r[1].filter((c) => String(c ?? '').trim() === '').length, 0)
  const allCells = grid.rows.reduce((a, r) => a + r[1].length, 0)
  sizes.push({ fp, chars: body.length, rows: grid.rows.length, allCells, emptyCells })
}

if (!sizes.length) { console.log('対象なし'); process.exit(0) }
sizes.sort((a, b) => a.chars - b.chars)
const pct = (p) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))].chars
const sum = (f) => sizes.reduce((a, s) => a + f(s), 0)

console.log(`対象      : ${dayDirs.length}日分 / xlsx ${targets.length}件（解析できた ${sizes.length} / 日付セル無し ${noGrid} / 失敗 ${failed}）`)
console.log(`ルール文  : TRANSCRIBE_RULES ${TRANSCRIBE_RULES.length}字 / TEXT版 ${TRANSCRIBE_RULES_TEXT.length}字`)
console.log(`グリッド  : 中央値 ${pct(0.5).toLocaleString()}字 / 平均 ${Math.round(sum((s) => s.chars) / sizes.length).toLocaleString()}字`)
console.log(`            p75 ${pct(0.75).toLocaleString()} / p90 ${pct(0.9).toLocaleString()} / p99 ${pct(0.99).toLocaleString()} / 最大 ${sizes[sizes.length - 1].chars.toLocaleString()}`)
const emptyRatio = sum((s) => s.emptyCells) / sum((s) => s.allCells)
console.log(`空セル    : 全セルの ${(emptyRatio * 100).toFixed(1)}%（${sum((s) => s.emptyCells).toLocaleString()} / ${sum((s) => s.allCells).toLocaleString()}）`)

// 長いものが全体のどれだけを占めるか（上位を削ると何割減るか）
const total = sum((s) => s.chars)
for (const p of [0.9, 0.95, 0.99]) {
  const cut = pct(p)
  const over = sizes.filter((s) => s.chars > cut)
  const excess = over.reduce((a, s) => a + (s.chars - cut), 0)
  console.log(`上位${((1 - p) * 100).toFixed(0)}% (${over.length}件・${cut.toLocaleString()}字超) を ${cut.toLocaleString()}字で打ち切ると 全体の ${(excess / total * 100).toFixed(1)}% 減`)
}
console.log(`\n■ 一番長い5件`)
for (const s of sizes.slice(-5).reverse()) {
  console.log(`  ${s.chars.toLocaleString().padStart(9)}字  行${String(s.rows).padStart(4)}  空${(s.emptyCells / s.allCells * 100).toFixed(0)}%  ${path.basename(s.fp).slice(0, 50)}`)
}
