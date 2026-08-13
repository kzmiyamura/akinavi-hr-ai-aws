#!/usr/bin/env node
// probe_match_batch.mjs — 実データで match-batch のルールスコア内訳を確認する
//
// 画面に出る「スコア内訳（ルールベース）」は match-batch が作る。
// 判定を直したときに、実際の案件×人材でどう出るかをUIを触らずに確かめるための道具。
// AI採点は topN=0 で回避し、ルールのみ（ruleOnly）を見る。
//
// 使い方:
//   node scripts/probe_match_batch.mjs <project_id> <candidate_id> [<candidate_id> ...]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const [projectId, ...candidateIds] = process.argv.slice(2)
if (!projectId || candidateIds.length === 0) {
  console.error('usage: node scripts/probe_match_batch.mjs <project_id> <candidate_id> [...]'); process.exit(1)
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const get = async (q) => (await (await fetch(`${URL}/rest/v1/${q}`, { headers: H })).json())

const [p] = await get(`projects?id=eq.${projectId}&select=*`)
if (!p) { console.error('案件が見つからない'); process.exit(1) }
const cands = await get(`candidates?id=in.(${candidateIds.join(',')})&select=id,name,skills,experience_years,desired_rate,raw_profile`)

const projectRequirements = {
  title: p.title,
  requiredSkills: p.required_skills ?? [],
  niceToHaveSkills: p.raw_data?.niceToHaveSkills ?? [],
  budgetMin: p.budget_min, budgetMax: p.budget_max,
  workLocation: p.work_location, workPrefecture: p.work_prefecture,
  skillWeights: p.skill_weights, requiredExpYears: p.required_experience_years,
  remotePolicy: p.remote_policy, contractType: p.contract_type,
  roleSummary: p.role_summary, description: p.description,
}
const candidates = cands.map((c) => {
  const rp = c.raw_profile ?? {}
  return {
    id: c.id, name: c.name,
    skills: (c.skills ?? []).map(String),
    experienceYears: c.experience_years,
    desiredRate: c.desired_rate,
    prefecture: rp.prefecture ?? null,
    remoteAvailable: rp.remoteAvailable ?? null,
    wantsFullRemote: rp.wantsFullRemote ?? null,
    summary: rp.summary ?? '',
  }
})

console.log(`\n案件: ${p.title}`)
console.log(`  work_location="${p.work_location}"  work_prefecture="${p.work_prefecture}"`)
console.log(`  remote_policy="${p.remote_policy}"`)
console.log(`  必須: ${JSON.stringify(projectRequirements.requiredSkills)}`)
console.log(`  重み: ${JSON.stringify(p.skill_weights)}  必要経験年数: ${p.required_experience_years ?? '—'}\n`)

const res = await fetch(`${URL}/functions/v1/match-batch`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'project_to_candidates', projectRequirements, candidates, topN: 0 }),
})
const json = await res.json()
if (!res.ok || json.error) { console.error('match-batch 失敗:', res.status, JSON.stringify(json).slice(0, 300)); process.exit(1) }

for (const r of [...(json.results ?? []), ...(json.ruleOnly ?? [])]) {
  const c = candidates.find((x) => x.id === r.candidateId) ?? {}
  console.log(`■ ${c.name ?? r.candidateId}  居住地=${c.prefecture ?? '—'} リモート可=${c.remoteAvailable ?? '—'}`)
  console.log(`   ${r.ruleBreakdown ?? r.breakdown ?? '(内訳なし)'}`)
  console.log(`   保有スキル: ${(c.skills ?? []).slice(0, 14).join(', ')}\n`)
}
