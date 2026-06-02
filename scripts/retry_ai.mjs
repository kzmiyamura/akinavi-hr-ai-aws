import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1`
const supabase = createClient(SUPABASE_URL, ANON_KEY)

const projectId = '0ef3f7d5-9649-4bfa-87e1-77222406b170'
const projectReq = {
  title: '１．化成品メーカー向け保守開発案件',
  requiredSkills: ['保守開発', 'Java', 'テスト', 'Spring Boot', '基本設計'],
  budgetMin: null, budgetMax: 80,
  workLocation: '東京都 大森', remotePolicy: null,
  niceToHaveSkills: [],
}

const candidates = JSON.parse(readFileSync('/tmp/candidates_p2.json', 'utf8'))
const top10 = candidates.slice(0, 10)

function toCandidateBatchInput(c) {
  const rp = c.raw_profile ?? {}
  return {
    id: c.id, name: c.name,
    skills: Array.isArray(c.skills) ? c.skills : [],
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
}

const resp = await fetch(`${EDGE_URL}/match-batch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
  body: JSON.stringify({
    mode: 'project_to_candidates',
    projectRequirements: projectReq,
    candidates: top10.map(toCandidateBatchInput),
    weights: { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 },
    topN: 10,
  }),
})

if (!resp.ok) { console.log('Error:', resp.status, await resp.text()); process.exit(1) }
const data = await resp.json()
console.log('usedModel:', data.usedModel)
console.log('results:', data.results?.length)
data.results?.slice(0, 3).forEach(r => {
  console.log(`  score=${r.score} summary=${(r.summary ?? '').slice(0, 80)}`)
})

if (data.usedModel !== 'rule' && data.results?.length > 0) {
  // Update submissions with AI summaries
  let updated = 0
  for (const r of data.results) {
    const id = r.id ?? r.candidateId
    const { error } = await supabase.from('submissions').update({
      ai_summary: r.summary ?? '',
      match_score: r.score ?? r.ruleScore,
      ai_raw: {
        ruleScore: r.ruleScore,
        breakdown: r.breakdown,
        usedModel: data.usedModel,
        autoMatched: false,
        source: 'manual-rematch-retry',
      }
    }).eq('candidate_id', id).eq('project_id', projectId).eq('data_env', 'prod')
    if (error) console.error('update error:', error.message)
    else updated++
  }
  console.log(`Updated ${updated} submissions with AI summaries`)
}
