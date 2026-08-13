#!/usr/bin/env node
// inspect_sheet_dates.mjs — Excel経歴書の「日付に見えるセル」を全部並べる
//
// skillYears が実際の経験年数より大きく出たとき、どのセルが原因かを特定するための道具。
// 期間の異常は「日付書式が付いた数値」「Excelの1900年うるう日」「別表の古い日付」など
// 見た目では分からない形で混ざる。セルの生の型と表示文字列を並べて見る。
//
// 本番と同じ読み込みオプション（cellDates: true）を使う。ここを変えると本番と違う話になる。
//
// 使い方: node scripts/inspect_sheet_dates.mjs <candidate_id> [--all]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as XLSX from 'xlsx'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv[2]
const ALL = process.argv.includes('--all')
if (!id) { console.error('usage: node scripts/inspect_sheet_dates.mjs <candidate_id> [--all]'); process.exit(1) }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const [row] = await (await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=name,resume_url`, { headers: H })).json()
if (!row?.resume_url) { console.error('resume_url が無い'); process.exit(1) }
const buf = new Uint8Array(await (await fetch(row.resume_url, { headers: H })).arrayBuffer())
const wb = XLSX.read(buf, { cellDates: true })   // 本番 index.ts:7299 と同じ

console.log(`\n${row.name}  シート: ${wb.SheetNames.join(' / ')}`)
const YEAR_RE = /(19|20)\d{2}/
for (const name of wb.SheetNames) {
  const sh = wb.Sheets[name]
  const hits = []
  for (const [addr, cell] of Object.entries(sh)) {
    if (addr.startsWith('!')) continue
    const isDate = cell.t === 'd' || cell.v instanceof Date
    const text = String(cell.w ?? cell.v ?? '')
    if (!isDate && !(ALL && YEAR_RE.test(text))) continue
    const iso = cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : ''
    hits.push({ addr, t: cell.t, iso, w: cell.w ?? '', v: isDate ? iso : String(cell.v).slice(0, 30) })
  }
  console.log(`\n=== ${name}: 日付セル ${hits.length}件 ===`)
  const years = hits.filter((h) => h.iso).map((h) => Number(h.iso.slice(0, 4)))
  if (years.length) {
    const min = Math.min(...years), max = Math.max(...years)
    console.log(`   年の範囲: ${min} 〜 ${max}（差 ${max - min}年）`)
  }
  for (const h of hits) console.log(`   ${h.addr.padEnd(6)} t=${h.t} iso=${h.iso.padEnd(10)} w="${h.w}"`)
}
