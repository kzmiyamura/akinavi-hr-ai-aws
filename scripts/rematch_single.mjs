import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1`
const supabase = createClient(SUPABASE_URL, ANON_KEY)

const CANDIDATE_ID = '137f36ca-78af-4a6c-9a67-fafdc991b045'

const { data: c } = await supabase.from('candidates').select('*').eq('id', CANDIDATE_ID).single()
const rp = c.raw_profile ?? {}

const candidate = {
  id: c.id, name: c.name,
  skills: c.skills ?? [],
  experienceYears: c.experience_years,
  desiredRate: c.desired_rate ?? rp.desiredRate ?? null,
  summary: rp.summary ?? '',
  remoteAvailable: rp.remoteAvailable ?? null,
  wantsFullRemote: rp.wantsFullRemote ?? null,
  prefecture: rp.prefecture ?? null,
  agentComment: rp.agentComment ?? null,
  nationality: rp.nationality ?? null,
  selfPR: rp.selfPR ?? null,
  skillYears: rp.skillYears ?? null,
}

console.log('Candidate:', { name: c.name, skills: c.skills?.join(','), exp: c.experience_years, rate: c.desired_rate, pref: rp.prefecture })

const projects = [
  { id: '82da71a0-55a2-48c7-956f-52e7455c3741', title: '精密機器製造',
    req: { title: '精密機器製造案件', requiredSkills: ['SQL','テスト','Java','C#','基本設計','VB.net'], budgetMax: null, workLocation: '大阪府 新大阪', niceToHaveSkills: [] }},
  { id: '0ef3f7d5-9649-4bfa-87e1-77222406b170', title: '化成品メーカー',
    req: { title: '化成品メーカー向け保守開発案件', requiredSkills: ['保守開発','Java','テスト','Spring Boot','基本設計'], budgetMax: 80, workLocation: '東京都 大森', niceToHaveSkills: [] }},
]

const DEFAULT_WEIGHTS = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }

for (const p of projects) {
  const resp = await fetch(`${EDGE_URL}/match-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
    body: JSON.stringify({
      mode: 'project_to_candidates',
      projectRequirements: p.req,
      candidates: [candidate],
      weights: DEFAULT_WEIGHTS,
      topN: 1,
    }),
  })
  const data = await resp.json()
  const r = [...(data.results ?? []), ...(data.ruleOnly ?? [])][0]
  if (!r) { console.log(`${p.title}: no result`); continue }
  console.log(`\n${p.title}: score=${r.score} rule=${r.ruleScore} model=${data.usedModel}`)
  console.log('  summary:', r.summary?.slice(0, 100))
  console.log('  breakdown:', r.breakdown)

  const { error } = await supabase.from('submissions').upsert({
    candidate_id: CANDIDATE_ID,
    project_id: p.id,
    data_env: 'prod',
    match_score: r.score ?? r.ruleScore,
    ai_summary: r.summary ?? '',
    status: 'pending',
    created_by: 'system',
    ai_raw: { ruleScore: r.ruleScore, breakdown: r.breakdown, usedModel: data.usedModel, source: 'rematch-single' }
  }, { onConflict: 'candidate_id,project_id' })
  if (error) console.error('upsert error:', error.message)
  else console.log('  ✅ upserted')
}
