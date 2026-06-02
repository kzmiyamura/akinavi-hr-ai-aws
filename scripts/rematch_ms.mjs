import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1`
const supabase = createClient(SUPABASE_URL, ANON_KEY)
const DEFAULT_WEIGHTS = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }

// 精密機器製造案件に含まれる戸部駅M.S 3件すべて再マッチ
const candidateIds = [
  'c149984b-afe6-4757-8c01-2fb1e26dec30',
  'b7b1e14c-c9f0-4fdd-9e09-fe056132aa2b',
  '083f9b44-95e5-421d-a207-3702fb032ace',
]

const projectId = '82da71a0-55a2-48c7-956f-52e7455c3741'
const projectReq = {
  title: '精密機器製造・販売会社向け生産管理業務の支援及び関連サブシステムの保守案件',
  requiredSkills: ['SQL','テスト','Java','C#','基本設計','VB.net'],
  budgetMax: null, workLocation: '大阪府 新大阪', niceToHaveSkills: [],
}

for (const cid of candidateIds) {
  const { data: c } = await supabase.from('candidates').select('*').eq('id', cid).single()
  if (!c) { console.log(`Not found: ${cid}`); continue }
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
  }

  console.log(`\n${c.name} (${rp.prefecture}) rate=${c.desired_rate} exp=${c.experience_years}`)

  const resp = await fetch(`${EDGE_URL}/match-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
    body: JSON.stringify({
      mode: 'project_to_candidates',
      projectRequirements: projectReq,
      candidates: [candidate],
      weights: DEFAULT_WEIGHTS,
      topN: 1,
    }),
  })
  const data = await resp.json()
  const r = [...(data.results ?? []), ...(data.ruleOnly ?? [])][0]
  if (!r) { console.log('  no result'); continue }

  console.log(`  score=${r.score} rule=${r.ruleScore} model=${data.usedModel}`)
  console.log(`  breakdown: ${r.breakdown}`)
  if (r.summary) console.log(`  summary: ${r.summary.slice(0, 80)}`)

  const { error } = await supabase.from('submissions').upsert({
    candidate_id: cid,
    project_id: projectId,
    data_env: 'prod',
    match_score: r.score ?? r.ruleScore,
    ai_summary: r.summary ?? '',
    status: 'pending',
    created_by: 'system',
    ai_raw: { ruleScore: r.ruleScore, breakdown: r.breakdown, usedModel: data.usedModel, source: 'rematch-single' }
  }, { onConflict: 'candidate_id,project_id' })
  if (error) console.error('  upsert error:', error.message)
  else console.log('  ✅ upserted')
}
console.log('\nDone!')
