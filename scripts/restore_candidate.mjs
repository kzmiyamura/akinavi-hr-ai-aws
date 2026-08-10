#!/usr/bin/env node
// restore_candidate.mjs — 非人材として隔離された候補者の復活（誤検知時用）
//
// 隔離 = merged_into を自己参照にして全一覧から除外している状態。
// null に戻し、raw_profile._quarantine を除去して一覧に復活させる。
// 使い方: node scripts/restore_candidate.mjs <candidate_id>
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv[2]
if (!/^[0-9a-f-]{36}$/.test(id ?? '')) { console.error('使い方: node scripts/restore_candidate.mjs <candidate_id(uuid)>'); process.exit(1) }

const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const rows = await (await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=id,name,merged_into,raw_profile`, { headers: h })).json()
const c = rows[0]
if (!c) { console.error('候補者が見つかりません:', id); process.exit(1) }
if (c.merged_into !== c.id) { console.error(`隔離状態ではありません（merged_into=${c.merged_into}）`); process.exit(1) }

const rp = { ...c.raw_profile }
delete rp._quarantine
const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${id}`, {
  method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
  body: JSON.stringify({ merged_into: null, raw_profile: rp }),
})
console.log(res.ok ? `✅ 復活: ${c.name}（一覧に再表示されます）` : `❌ ${res.status}`)
