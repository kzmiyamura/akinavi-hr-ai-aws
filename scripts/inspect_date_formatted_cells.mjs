#!/usr/bin/env node
/**
 * inspect_date_formatted_cells.mjs
 *   「日付書式が付いた小さい数値」セルを洗い出す調査ツール。
 *
 * 本番は XLSX.read(..., { cellDates: true }) で読む（index.ts:7299）ため、
 * 日付書式が付いた数値セルは Date になる。値が小さいと 1900〜1902年の日付に化け、
 * cellToText がそれを "1900/9/9" のような日付文字列として出力してしまう。
 * 期間列だと誤解されてスキル表の抽出が丸ごと壊れることがある
 * （実例: T.A の「TAスキルシート」— cellDates:false なら52スキル取れるのに本番では0件）。
 *
 * 何を見るか: 化けているセルの「元の数値」「書式(z)」「列の見出し候補」「同じ行の前後」。
 * その列が本当は何なのか（規模の人月・件数・年数 等）を人が判断するための材料。
 *
 * 使い方:
 *   node scripts/inspect_date_formatted_cells.mjs <candidate_id>
 *   node scripts/inspect_date_formatted_cells.mjs <resume_url>
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL_BASE = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY

const arg = process.argv[2]
if (!arg) { console.log('使い方: node scripts/inspect_date_formatted_cells.mjs <candidate_id|resume_url>'); process.exit(0) }

let resumeUrl = arg
if (!/^https?:\/\//.test(arg)) {
  if (!URL_BASE || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }
  const res = await fetch(`${URL_BASE}/rest/v1/candidates?id=eq.${arg}&select=name,resume_url`, { headers })
  const [c] = await res.json()
  if (!c) { console.log('見つかりません'); process.exit(0) }
  console.log(`${c.name}  ${c.resume_url}\n`)
  resumeUrl = c.resume_url
}

const buf = new Uint8Array(await (await fetch(resumeUrl)).arrayBuffer())
const wb = XLSX.read(buf, { type: 'array', cellDates: true })  // 本番と同じ
const wbRaw = XLSX.read(buf, { type: 'array' })                // 比較用（元の数値を見る）

let total = 0
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name], wsRaw = wbRaw.Sheets[name]
  if (!ws['!ref']) continue
  const range = XLSX.utils.decode_range(ws['!ref'])
  const hits = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr]
      if (!cell || !(cell.v instanceof Date)) continue
      const y = cell.v.getUTCFullYear()
      if (y >= 1910) continue   // 1910年より前＝実在の日付ではありえない
      hits.push({ addr, r, c, w: cell.w, rawV: wsRaw[addr]?.v, z: cell.z })
    }
  }
  total += hits.length
  if (hits.length === 0) continue
  console.log(`=== シート「${name}」 化けているセル ${hits.length}個 ===`)
  for (const h of hits.slice(0, 15)) {
    // 同じ列の上方向にある直近の非空セル＝見出し候補
    let header = ''
    for (let rr = h.r - 1; rr >= Math.max(0, h.r - 12); rr--) {
      const hv = ws[XLSX.utils.encode_cell({ r: rr, c: h.c })]
      if (hv && String(hv.w ?? hv.v).trim()) { header = String(hv.w ?? hv.v).trim(); break }
    }
    const around = []
    for (let cc = Math.max(0, h.c - 2); cc <= h.c + 2; cc++) {
      const av = ws[XLSX.utils.encode_cell({ r: h.r, c: cc })]
      if (av) around.push(`${XLSX.utils.encode_col(cc)}=${String(av.w ?? av.v).slice(0, 20)}`)
    }
    console.log(`  ${h.addr.padEnd(6)} 表示="${h.w}"  元の数値=${h.rawV}  書式z="${h.z}"`)
    console.log(`        列の見出し候補: ${header}`)
    console.log(`        同じ行: ${around.join(' | ')}`)
  }
  if (hits.length > 15) console.log(`  …他${hits.length - 15}個`)
  console.log('')
}
if (total === 0) console.log('化けているセルはありません')
