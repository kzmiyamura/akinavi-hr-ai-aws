#!/usr/bin/env node
// invoke_notify.mjs — notify-candidates を1回だけ手動実行する（2026-08-17）
//
// cron は毎時0分なので、設定変更（Microsoft 再連携など）の直後に
// 待たずに確認したいとき用。実際にメールが送られる点に注意。
//
// 使い方:
//   node scripts/invoke_notify.mjs                                  # 本番と同じ1周（新着ぶんを通知）
//   node scripts/invoke_notify.mjs --test --dry                     # 試し送信の下見（送らない）
//   node scripts/invoke_notify.mjs --test --days 7 --limit 10       # 直近7日から最大10人を試し送信
//   node scripts/invoke_notify.mjs --test --rule <uuid> --to a@b.c  # ルール・宛先を指定
//
// 試し送信（--test）は notification_log にも notify_last_checked_at にも書かないので、
// 本番の通知が「送信済み」で飛ばされることはない（2026-10-10 追加）。
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

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

let payload = {}
if (has('--test')) {
  const test = { dryRun: has('--dry') }
  if (val('--days')) test.days = Number(val('--days'))
  if (val('--limit')) test.limit = Number(val('--limit'))
  if (val('--rule')) test.ruleId = val('--rule')
  if (val('--to')) test.to = val('--to')
  payload = { test }
  console.log(`試し送信${test.dryRun ? 'の下見（メールは送りません）' : '（メールを送ります）'}:`,
    JSON.stringify(test))
} else {
  console.log('本番と同じ1周を実行します（新着があればメールが飛びます）')
}

const res = await fetch(`${URL}/functions/v1/notify-candidates`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
const text = await res.text()
console.log(`HTTP ${res.status}`)
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2))
} catch {
  console.log(text)
}
