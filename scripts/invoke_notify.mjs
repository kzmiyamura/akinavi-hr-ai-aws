#!/usr/bin/env node
// invoke_notify.mjs — notify-candidates を1回だけ手動実行する（2026-08-17）
//
// cron は毎時0分なので、設定変更（Microsoft 再連携など）の直後に
// 待たずに確認したいとき用。実際にメールが送られる点に注意。
//
// 使い方: node scripts/invoke_notify.mjs
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }

const res = await fetch(`${URL}/functions/v1/notify-candidates`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
})
const text = await res.text()
console.log(`HTTP ${res.status}`)
console.log(text)
