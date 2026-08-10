#!/usr/bin/env node
// recent_llm_cases.mjs — 直近のAI校正の実例を「どのモデルが何をしたか」で一覧する
//
// - Sonnet昇格まで行った人（重い経歴書）
// - Haikuだけで完了した人（早期リターン）
// - 解析対象が無く即完了した人（本文のみ・添付なし）
// を分けて表示し、それぞれ何分かかったかを出す。
//
// 使い方: node scripts/llm_extract/recent_llm_cases.mjs [件数=3]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const N = Number(process.argv[2] ?? 3)
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const get = async (q) => {
  const res = await fetch(`${URL}/rest/v1/${q}`, { headers: h })
  if (!res.ok) throw new Error(`${q} -> ${res.status}`)
  return res.json()
}

const shadow = await get('llm_shadow?select=candidate_id,source,model,status,reasons,ms,created_at' +
  '&source=eq.attachment&order=created_at.desc&limit=200')

const byModel = { sonnet: [], haiku: [] }
for (const r of shadow) {
  if (r.status === 'error') continue
  if (byModel[r.model]) byModel[r.model].push(r)
}

async function describe(r) {
  const [c] = await get(`candidates?select=name,experience_years,skills,` +
    `pj:raw_profile->projects,sy:raw_profile->skillYears,ap:raw_profile->_llm_applied,` +
    `created_at&id=eq.${r.candidate_id}`)
  if (!c) return null
  const sy = Object.keys(c.sy ?? {}).filter((k) => !k.startsWith('_')).length
  const lag = c.ap?.at ? ((new Date(c.ap.at) - new Date(c.created_at)) / 60000).toFixed(0) : '—'
  return `  ${c.name}: 案件${(c.pj ?? []).length}件 / スキル年数${sy}語 / 経験${c.experience_years ?? '?'}年 / ` +
    `解析${(r.ms / 1000).toFixed(0)}秒 / 登録から${lag}分 / 上書き=${(c.ap?.fields ?? []).join(',') || 'なし'}` +
    `${r.reasons?.length ? `\n      検証: ${r.reasons.join('|')}` : ''}`
}

console.log('=== Sonnet まで昇格した人（Haikuの結果が基準未満だった重い経歴書）===')
for (const r of byModel.sonnet.slice(0, N)) {
  const line = await describe(r)
  if (line) console.log(line)
}
console.log('\n=== Haiku だけで完了した人（早期リターン・Sonnet不要）===')
for (const r of byModel.haiku.slice(0, N)) {
  const line = await describe(r)
  if (line) console.log(line)
}

// 添付なし＝本文Haikuのみで即完了した人
const bodyOnly = await get('llm_shadow?select=candidate_id,ms,created_at&source=eq.body' +
  '&order=created_at.desc&limit=60')
const attachIds = new Set(shadow.map((r) => r.candidate_id))
console.log('\n=== 経歴書なし・本文Haikuのみで即完了した人（最速パターン）===')
let shown = 0
for (const r of bodyOnly) {
  if (attachIds.has(r.candidate_id) || shown >= N) continue
  const [c] = await get(`candidates?select=name,created_at,ap:raw_profile->_llm_applied,` +
    `chk:raw_profile->>_llm_checked_at&id=eq.${r.candidate_id}`)
  if (!c) continue
  const end = c.ap?.at ?? c.chk
  const lag = end ? ((new Date(end) - new Date(c.created_at)) / 60000).toFixed(0) : '—'
  console.log(`  ${c.name}: 本文解析${(r.ms / 1000).toFixed(0)}秒 / 登録から${lag}分 / ` +
    `上書き=${(c.ap?.fields ?? []).join(',') || 'なし（変更不要）'}`)
  shown++
}
