#!/usr/bin/env node
/**
 * 経歴書グリッドを「意味を落とさずに」どこまで縮められるかを実データで測る。
 *
 * 背景: measure_prompt_size.mjs で、AIに送っているセルの **92.3% が空文字** と分かった
 * （中央値 25,946字・平均 37,044字。ルール文は941字しかない）。
 * グリッドは矩形なので、シートの最大幅に合わせて全行が空セルで埋められている。
 *
 * ただし空セルは **列位置** を表しているので、無条件に消すと桁がずれて転記が壊れる。
 * そこで「位置情報を失わない縮め方」だけを候補にして、それぞれの削減率を数える。
 *
 *   A 現状          … [行番号, ["","","A","",...]]
 *   B 末尾の空を落とす … 行末の空セルは後ろに何も無いので位置情報を持たない（完全に無損失）
 *   C 空行を落とす    … 全セルが空の行（行番号は残すので位置は追える）
 *   D 疎表現        … [行番号, [[列番号,"A"],[列番号,"B"]]] 空セルを送らない
 *   B+C+D を重ねた場合も出す。
 *
 * 本番を一切引かない（egress ゼロ）。
 *
 *   node scripts/measure_grid_compaction.mjs [--days 2] [--limit 250]
 */
import fs from 'fs'
import path from 'path'
import { buildGridInput } from './llm_extract/lib.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROOT = argOf('--dir', 'D:\\akinavi-archive\\mail')
const DAYS = Number(argOf('--days', '2'))
const LIMIT = Number(argOf('--limit', '250'))

const isEmpty = (c) => String(c ?? '').trim() === ''

/** 行末の空セルを落とす（後ろに値が無いので列位置の情報を持たない＝無損失） */
const trimTail = (cells) => {
  let end = cells.length
  while (end > 0 && isEmpty(cells[end - 1])) end--
  return cells.slice(0, end)
}

const since = new Date(Date.now() - DAYS * 86400_000)
const dayDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => new Date(`${d.name}T23:59:59Z`) >= since)
  .map((d) => d.name).sort()

const targets = []
outer: for (const day of dayDirs) {
  for (const m of fs.readdirSync(path.join(ROOT, day), { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const dir = path.join(ROOT, day, m.name)
    for (const f of fs.readdirSync(dir)) {
      if (/\.(xlsx?|xlsm)$/i.test(f)) targets.push(path.join(dir, f))
      if (targets.length >= LIMIT) break outer
    }
  }
}

const tot = { A: 0, B: 0, C: 0, D: 0, BCD: 0 }
let n = 0
const per = []

for (const fp of targets) {
  let g
  try { g = buildGridInput(fp) } catch { continue }
  if (!g) continue
  n++
  const base = { sheet: g.sheet, merges: g.merges }

  const A = JSON.stringify(g).length

  const rowsB = g.rows.map(([i, cells]) => [i, trimTail(cells)])
  const B = JSON.stringify({ ...base, rows: rowsB }).length

  const rowsC = g.rows.filter(([, cells]) => cells.some((c) => !isEmpty(c)))
  const C = JSON.stringify({ ...base, rows: rowsC }).length

  const rowsD = g.rows.map(([i, cells]) => {
    const kv = []
    cells.forEach((c, j) => { if (!isEmpty(c)) kv.push([j, c]) })
    return [i, kv]
  })
  const D = JSON.stringify({ ...base, rows: rowsD }).length

  const rowsBCD = rowsD.filter(([, kv]) => kv.length > 0)
  const BCD = JSON.stringify({ ...base, rows: rowsBCD }).length

  tot.A += A; tot.B += B; tot.C += C; tot.D += D; tot.BCD += BCD
  per.push({ fp, A, BCD })
}

const pc = (v) => `${((1 - v / tot.A) * 100).toFixed(1)}%減`
console.log(`対象: ${n}件（${dayDirs.join(', ')}）`)
console.log(`A 現状            : 平均 ${Math.round(tot.A / n).toLocaleString()}字`)
console.log(`B 行末の空を落とす : 平均 ${Math.round(tot.B / n).toLocaleString()}字  ${pc(tot.B)}`)
console.log(`C 空行を落とす     : 平均 ${Math.round(tot.C / n).toLocaleString()}字  ${pc(tot.C)}`)
console.log(`D 疎表現          : 平均 ${Math.round(tot.D / n).toLocaleString()}字  ${pc(tot.D)}`)
console.log(`  空行も落とす(D+C): 平均 ${Math.round(tot.BCD / n).toLocaleString()}字  ${pc(tot.BCD)}`)

per.sort((a, b) => (b.A - b.BCD) - (a.A - a.BCD))
console.log(`\n■ 一番効くファイル5件（現状 → D+C）`)
for (const p of per.slice(0, 5)) {
  console.log(`  ${p.A.toLocaleString().padStart(9)} → ${p.BCD.toLocaleString().padStart(8)}字  ${path.basename(p.fp).slice(0, 48)}`)
}
