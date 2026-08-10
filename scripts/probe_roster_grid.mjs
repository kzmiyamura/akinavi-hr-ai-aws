#!/usr/bin/env node
// probe_roster_grid.mjs — 名簿(ROSTER)誤検出の調査用。スプレッドシートの生グリッドを列番号付きで表示する。
//
// 「なぜこの列を氏名列と判断したのか」を人が目視で確認するためのツール。
// 使い方:
//   node scripts/probe_roster_grid.mjs <GoogleスプレッドシートURL or ID> [表示行数=12]
import { read, utils } from 'xlsx'

const arg = process.argv[2] ?? ''
const LIMIT = Number(process.argv[3] ?? 12)
const id = arg.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? arg
if (!id) { console.error('使い方: node scripts/probe_roster_grid.mjs <URL or ID> [行数]'); process.exit(1) }

const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`
const res = await fetch(url)
if (!res.ok) { console.error(`取得失敗: ${res.status}（非公開シートの可能性）`); process.exit(1) }
const wb = read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })

for (const sheetName of wb.SheetNames) {
  const grid = utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: '' })
  console.log(`\n=== シート「${sheetName}」 ${grid.length}行 ===`)
  for (const [r, row] of grid.slice(0, LIMIT).entries()) {
    const cells = row.map((c, i) => `[${i}]${String(c ?? '').replace(/\s+/g, ' ').slice(0, 18)}`).join(' | ')
    console.log(`r${r}: ${cells}`)
  }
}
