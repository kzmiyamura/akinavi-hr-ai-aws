#!/usr/bin/env node
// replay_candidate.mjs — 候補者の再解析依頼（UI「再解析」ボタンのCLI版）
//
// 保存済みの元メール本文・件名・from と storage の経歴書を inbound-email に再投入し、
// regex 再解析 → 常駐ワーカーの後追いLLM補正までの流れに乗せる。
// 承認ダイアログ回避のためのスクリプト（node -e を書かない。CLAUDE.md 方針）。
// 恒久許可: "Bash(node scripts/llm_extract/replay_candidate.mjs *)"
//
// 使い方: node scripts/llm_extract/replay_candidate.mjs <candidate_id>
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv[2]
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }
if (!id) { console.error('使い方: node scripts/llm_extract/replay_candidate.mjs <candidate_id>'); process.exit(1) }

const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const rows = await (await fetch(
  `${URL}/rest/v1/candidates?id=eq.${id}&select=id,name,data_env,resume_url,` +
  `subject:raw_profile->>subject,body:raw_profile->>text,mailfrom:raw_profile->>from`, { headers: h })).json()
const c = rows[0]
if (!c) { console.error('候補者が見つかりません:', id); process.exit(1) }
if (!c.body) { console.error('raw_profile.text が無いため再解析できません'); process.exit(1) }

// storage の経歴書があれば添付として同送（拡張子から mimeType を推定）
const attachments = []
if (c.resume_url?.includes('/storage/v1/object/public/attachments/')) {
  const res = await fetch(c.resume_url)
  if (res.ok) {
    const name = decodeURIComponent(c.resume_url.split('/').pop() ?? 'resume')
    attachments.push({
      data: Buffer.from(await res.arrayBuffer()).toString('base64'),
      mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      name,
    })
  }
}

const resp = await fetch(`${URL}/functions/v1/inbound-email`, {
  method: 'POST', headers: h,
  body: JSON.stringify({
    subject: c.subject ?? `【再解析】${c.name}`,
    body: c.body,
    from: c.mailfrom || `replay+${c.id}@demo.invalid`,
    attachments,
    mode: c.data_env, type: 'candidate', force: true, target_candidate_id: c.id,
  }),
})
const j = await resp.json().catch(() => ({}))
console.log(resp.ok ? `✅ ${c.name} 再解析依頼OK（添付${attachments.length}件）` : `❌ ${resp.status}`, JSON.stringify(j).slice(0, 200))
