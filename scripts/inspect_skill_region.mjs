#!/usr/bin/env node
// inspect_skill_region.mjs — 1ファイルのシート構造を本番と同じ整形で覗く
//
// 「期間は取れるがスキルが0件」の原因を、成功ファイルと失敗ファイルの
// 構造差から特定するための調査用。worksheetToGrid は本番(inbound-email)と同じものを使う。
//
// 使い方:
//   node scripts/inspect_skill_region.mjs <ファイル名> [シート名] [最大行数=60]
//   node scripts/inspect_skill_region.mjs H_K.xlsx            # 既定シートを表示
//   node scripts/inspect_skill_region.mjs H_K.xlsx スキルシート 80
import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { worksheetToGrid } from './_extractors.gen.mjs'

const [file, sheetArg, maxArg] = process.argv.slice(2)
if (!file) { console.error('usage: inspect_skill_region.mjs <file> [sheet] [maxRows]'); process.exit(1) }
const MAX = Number(maxArg ?? 60)

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testData/excel')
const wb = XLSX.readFile(join(dir, file), { cellDates: true })
console.log(`FILE: ${file}`)
console.log(`シート: ${wb.SheetNames.map((s) => `"${s}"`).join(', ')}\n`)

const DATE = /(19|20)\d{2}[\/年.\-]\d{1,2}/
// 技術トークンらしさ（verify.mjs の gridTechTokens と同じ考え方の簡易版）
const TECHISH = /^[A-Za-zＡ-Ｚａ-ｚ][A-Za-z0-9＋+#.\s]{1,23}$/

const sheet = sheetArg ?? wb.SheetNames[0]
const ws = wb.Sheets[sheet]
if (!ws) { console.error(`シート "${sheet}" が無い`); process.exit(1) }
const grid = worksheetToGrid(ws)
const merges = (ws['!merges'] ?? []).map((m) => `r${m.s.r}-${m.e.r}/c${m.s.c}-${m.e.c}`)

console.log(`--- シート "${sheet}" 行数=${grid.length} 結合セル=${merges.length}件 ---`)
console.log('凡例: [D]=日付を含む行  [T]=技術トークンらしいセルを含む行\n')

let shown = 0
for (let i = 0; i < grid.length && shown < MAX; i++) {
  const cells = grid[i].map((c) => String(c ?? '').trim())
  if (!cells.some(Boolean)) continue
  const hasDate = cells.some((c) => DATE.test(c))
  const techs = cells.filter((c) => TECHISH.test(c) && c.length >= 2)
  const tag = `${hasDate ? '[D]' : '   '}${techs.length ? '[T]' : '   '}`
  // 列位置が分かるよう c<列番号>: を付ける（対応付けのズレを見るため）
  const body = cells.map((c, ci) => (c ? `c${ci}:${c.slice(0, 28)}` : null)).filter(Boolean).join(' | ')
  console.log(`${tag} r${String(i).padStart(3)} ${body.slice(0, 220)}`)
  shown++
}
if (merges.length) console.log(`\n結合セル(先頭20): ${merges.slice(0, 20).join(', ')}`)
