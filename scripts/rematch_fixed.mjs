import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1`
const supabase = createClient(SUPABASE_URL, ANON_KEY)
const DEFAULT_WEIGHTS = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }

const PROJECT = {
  id: '82da71a0-55a2-48c7-956f-52e7455c3741',
  title: '精密機器製造',
  req: {
    title: '１．精密機器製造・販売会社向け生産管理業務の支援及び関連サブシステムの保守案件',
    requiredSkills: ['SQL', 'テスト', 'Java', 'C#', '基本設計', 'VB.net'],
    budgetMin: null, budgetMax: null,
    workLocation: '大阪府 新大阪', remotePolicy: null,
    niceToHaveSkills: [],
  }
}

function toCandidateBatchInput(c) {
  const rp = c.raw_profile ?? {}
  return {
    id: c.id,
    name: c.name,
    skills: Array.isArray(c.skills) ? c.skills : (c.skills ? JSON.parse(c.skills) : []),
    experienceYears: c.experience_years,
    desiredRate: c.desired_rate ?? rp.desiredRate ?? null,
    summary: rp.summary ?? '',
    remoteAvailable: rp.remoteAvailable ?? null,
    wantsFullRemote: rp.wantsFullRemote ?? null,
    prefecture: rp.prefecture ?? null,
    availableRegions: Array.isArray(rp.availableRegions) ? rp.availableRegions : null,
    preferredJobTypes: Array.isArray(rp.roles) ? rp.roles : null,
    agentComment: rp.agentComment ?? null,
    nationality: rp.nationality ?? null,
    selfPR: rp.selfPR ?? null,
    skillYears: rp.skillYears ?? null,
    desiredProject: rp.desiredProject ?? null,
  }
}

async function callMatchBatch(projectReq, candidates, topN) {
  const resp = await fetch(`${EDGE_URL}/match-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
    body: JSON.stringify({
      mode: 'project_to_candidates',
      projectRequirements: projectReq,
      candidates: candidates.map(toCandidateBatchInput),
      weights: DEFAULT_WEIGHTS,
      topN,
    }),
  })
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`)
  return await resp.json()
}

const candidates = JSON.parse(readFileSync('/tmp/fixed_candidates.json', 'utf8'))
console.log(`Candidates to re-match: ${candidates.length}`)

// Process in chunks of 20, topN=10 for first batch
const CHUNK = 20
const TOP_N = 10
let allResults = []
let allRuleOnly = []
let usedModel = 'rule'

for (let i = 0; i < candidates.length; i += CHUNK) {
  const chunk = candidates.slice(i, i + CHUNK)
  const isFirst = i === 0
  console.log(`\nBatch ${i/CHUNK + 1}: ${chunk.length} candidates (topN=${isFirst ? TOP_N : 0})`)
  try {
    const data = await callMatchBatch(PROJECT.req, chunk, isFirst ? TOP_N : 0)
    console.log(`  usedModel: ${data.usedModel}`)
    if (data.results?.length > 0) {
      allResults.push(...data.results)
      usedModel = data.usedModel
      data.results.slice(0, 5).forEach(r => {
        console.log(`    AI: score=${r.score} rule=${r.ruleScore} ${(r.summary ?? '').slice(0, 60)}`)
      })
    }
    if (data.ruleOnly?.length > 0) {
      allRuleOnly.push(...data.ruleOnly)
      data.ruleOnly.slice(0, 5).forEach(r => {
        console.log(`    Rule: score=${r.ruleScore} id=${r.id?.slice(0,8)}`)
      })
    }
  } catch (e) {
    console.error(`  Batch ${i/CHUNK + 1} failed:`, e.message)
  }
}

// Build result maps
const aiResultMap = new Map((allResults).map(r => [r.id ?? r.candidateId, r]))
const ruleMap = new Map((allRuleOnly).map(r => [r.id ?? r.candidateId, r]))

let inserted = 0, errors = 0
for (const c of candidates) {
  const ai = aiResultMap.get(c.id)
  const ruleOnly = ruleMap.get(c.id)
  let score, summary, breakdown, ruleScore

  if (ai) {
    score = ai.score ?? ai.ruleScore ?? 0
    summary = ai.summary ?? ''
    breakdown = ai.breakdown ?? ''
    ruleScore = ai.ruleScore ?? 0
  } else if (ruleOnly) {
    score = ruleOnly.ruleScore ?? 0
    summary = ''
    breakdown = ruleOnly.breakdown ?? ''
    ruleScore = ruleOnly.ruleScore ?? 0
  } else {
    console.log(`  No result for ${c.id?.slice(0,8)} ${c.name}`)
    continue
  }

  const { error } = await supabase.from('submissions').upsert({
    candidate_id: c.id,
    project_id: PROJECT.id,
    data_env: 'prod',
    match_score: score,
    ai_summary: summary,
    status: 'pending',
    created_by: 'system',
    ai_raw: {
      ruleScore,
      breakdown,
      usedModel: ai ? usedModel : 'rule',
      autoMatched: false,
      source: 'manual-rematch-prefecture-fix',
    }
  }, { onConflict: 'candidate_id,project_id' })

  if (error) { console.error('upsert error:', error.message.slice(0, 80)); errors++ }
  else inserted++
}
console.log(`\nUpserted ${inserted} (${errors} errors)`)
console.log('Done!')
