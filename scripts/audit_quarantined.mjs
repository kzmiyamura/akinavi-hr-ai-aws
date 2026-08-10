#!/usr/bin/env node
// audit_quarantined.mjs — 隔離済み人材の一覧（誤検知がないかの確認・まとめて削除/復活の判断用）
//
// 隔離 = merged_into が自分自身。一覧からは見えないがデータは残っている。
// 通知はメール単位で1件に集約しているため、全体像はここで見る。
//
// 使い方:
//   node scripts/audit_quarantined.mjs [日数=7]          # 一覧
//   node scripts/audit_quarantined.mjs [日数] --delete   # 一括削除（元に戻せない）
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const DEL = process.argv.includes('--delete')
const DAYS = Number(process.argv.filter((a) => /^\d+$/.test(a))[0] ?? 7)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const rows = await (await fetch(`${URL}/rest/v1/candidates?select=id,name,from_company,created_at,` +
  `reason:raw_profile->_quarantine->>reason,detail:raw_profile->_quarantine->>detail,` +
  `subj:raw_profile->>subject&data_env=eq.prod&created_at=gte.${since}` +
  `&raw_profile->_quarantine=not.is.null&order=created_at.desc&limit=500`, { headers: h })).json()

// 元メール単位でまとめる（1通から複数の幽霊が出るため）
const groups = new Map()
for (const c of rows) {
  const k = `${c.from_company ?? '?'}｜${(c.subj ?? '').slice(0, 40)}`
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(c)
}
console.log(`=== 隔離済み人材（prod・直近${DAYS}日）: ${rows.length}件 / 元メール${groups.size}通 ===`)
for (const [k, list] of groups) {
  console.log(`\n■ ${k}  （${list.length}件）`)
  console.log(`   理由: ${list[0].detail ?? list[0].reason}`)
  console.log(`   名前: ${list.map((c) => c.name).join(', ')}`)
}
if (!DEL || !rows.length) { console.log(`\n（--delete で ${rows.length}件を完全削除。誤検知の復活は restore_candidate.mjs）`); process.exit(0) }

let ok = 0
for (const c of rows) {
  const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${c.id}`, { method: 'DELETE', headers: { ...h, Prefer: 'return=minimal' } })
  if (res.ok) ok++
}
console.log(`\n削除完了: ${ok}/${rows.length}件`)
