#!/usr/bin/env node
// replay_email_group.mjs — 同一メール（同じ from + 件名）由来の人材をまとめて再解析する
//
// 複数人メールは block[0] にしか target_candidate_id を強制適用できないため、
// 1人ずつ再解析するとデータが混線する。代わりに force 無しで丸ごと再投入し、
// inbound-email 側の dedup（同一 from + 同名）で既存レコードを更新させる。
//
// 使い方: node scripts/llm_extract/replay_email_group.mjs <代表candidate_id>
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv[2]
if (!/^[0-9a-f-]{36}$/.test(id ?? '')) { console.error('使い方: node scripts/llm_extract/replay_email_group.mjs <candidate_id>'); process.exit(1) }
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const [c] = await (await fetch(`${URL}/rest/v1/candidates?id=eq.${id}` +
  `&select=id,name,data_env,subject:raw_profile->>subject,body:raw_profile->>text,mailfrom:raw_profile->>from`, { headers: h })).json()
if (!c?.body) { console.error('本文が見つかりません'); process.exit(1) }

const sibs = await (await fetch(`${URL}/rest/v1/candidates?select=id,name` +
  `&raw_profile->>from=eq.${encodeURIComponent(c.mailfrom)}&raw_profile->>subject=eq.${encodeURIComponent(c.subject)}` +
  `&data_env=eq.${c.data_env}`, { headers: h })).json()
console.log(`同一メール由来: ${sibs.length}人 [${sibs.map((s) => s.name).join(', ')}]`)

const resp = await fetch(`${URL}/functions/v1/inbound-email`, {
  method: 'POST', headers: h,
  body: JSON.stringify({
    subject: c.subject, body: c.body, from: c.mailfrom,
    attachments: [], mode: c.data_env, type: 'candidate', force: true,
  }),
})
const j = await resp.json().catch(() => ({}))
console.log(resp.ok ? '✅ 再解析依頼OK' : `❌ ${resp.status}`, JSON.stringify(j).slice(0, 200))

const after = await (await fetch(`${URL}/rest/v1/candidates?select=name` +
  `&raw_profile->>from=eq.${encodeURIComponent(c.mailfrom)}&raw_profile->>subject=eq.${encodeURIComponent(c.subject)}` +
  `&data_env=eq.${c.data_env}&order=created_at.asc`, { headers: h })).json()
console.log(`再解析後: ${after.length}人 [${after.map((s) => s.name).join(', ')}]`)
