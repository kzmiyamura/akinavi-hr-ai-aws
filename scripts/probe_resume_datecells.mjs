#!/usr/bin/env node
// probe_resume_datecells.mjs — LLM経路が経歴書を「日付セルなし」で弾く原因を見る
//
// llm_extract/lib.mjs の buildGridInput は「セル文字列が西暦で始まる」ものだけを
// 日付セルと数え、1つも無ければ null を返す（＝AI校正が経歴書を読まずに終わる）。
// regex 経路（inbound-email）は別方式でセル座標から期間を取るため、
// 「regexは読めているのにAIには渡っていない」状態が起きる。その切り分け用。
//
// 使い方: node scripts/probe_resume_datecells.mjs <経歴書のURL または ローカルパス>
import XLSX from 'xlsx'
import { worksheetToGrid } from './_extractors.gen.mjs'

const src = process.argv[2]
if (!src) { console.error('使い方: node scripts/probe_resume_datecells.mjs <url|path>'); process.exit(1) }

const wb = /^https?:/.test(src)
  ? XLSX.read(Buffer.from(await (await fetch(src)).arrayBuffer()), { cellDates: true })
  : XLSX.readFile(src, { cellDates: true })

// buildGridInput と同じ判定（先頭一致）と、緩めた判定（部分一致）を並べる
const ANCHORED = /^(19|20)\d{2}[/年.\-]\d{1,2}/
const LOOSE = /(19|20)\d{2}\s*[/年.\-]\s*\d{1,2}/

for (const sn of wb.SheetNames) {
  const grid = worksheetToGrid(wb.Sheets[sn])
  const cells = grid.flat().map((c) => String(c).trim()).filter(Boolean)
  const anchored = cells.filter((c) => ANCHORED.test(c))
  const loose = cells.filter((c) => LOOSE.test(c))
  console.log(`\n=== ${sn}  行=${grid.length} セル=${cells.length}  先頭一致=${anchored.length} 部分一致=${loose.length}`)
  if (loose.length) console.log('  日付らしいセル:', [...new Set(loose)].slice(0, 8))
  const sample = cells.filter((c) => /\d/.test(c) && c.length <= 24)
  console.log('  数字を含むセルの例:', [...new Set(sample)].slice(0, 12))
}
