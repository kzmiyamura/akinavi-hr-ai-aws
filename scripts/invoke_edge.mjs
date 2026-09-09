#!/usr/bin/env node
// invoke_edge.mjs — Edge Function を1回だけ手動実行する（2026-09-09）
//
// cron を待たずに結果を確認したいとき用。invoke_notify.mjs の汎用版。
// ⚠ 本番に対して実際に処理が走る（cleanup-storage ならファイルが消える）。
//
// 使い方: node scripts/invoke_edge.mjs <関数名> [JSON本文]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const fn = process.argv[2]
if (!fn) { console.error('使い方: node scripts/invoke_edge.mjs <関数名> [JSON本文]'); process.exit(1) }
const body = process.argv[3] ?? '{}'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }

const startedAt = Date.now()
const res = await fetch(`${URL}/functions/v1/${fn}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body,
})
const text = await res.text()
console.log(`HTTP ${res.status}  ${(Date.now() - startedAt) / 1000}s`)
console.log(text)
