import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1`
const supabase = createClient(SUPABASE_URL, ANON_KEY)
const DEFAULT_WEIGHTS = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }
const BATCH_TOP_N = 10

const projects = [
  {
    id: '82da71a0-55a2-48c7-956f-52e7455c3741',
    title: '精密機器製造',
    candidatesFile: '/tmp/candidates_p1.json',
    req: {
      title: '１．精密機器製造・販売会社向け生産管理業務の支援及び関連サブシステムの保守案件',
      requiredSkills: ['SQL', 'テスト', 'Java', 'C#', '基本設計', 'VB.net'],
      budgetMin: null, budgetMax: null,
      workLocation: '大阪府 新大阪', remotePolicy: null,
      niceToHaveSkills: [],
    }
  },
  {
    id: '0ef3f7d5-9649-4bfa-87e1-77222406b170',
    title: '化成品メーカー',
    candidatesFile: '/tmp/candidates_p2.json',
    req: {
      title: '１．化成品メーカー向け保守開発案件',
      requiredSkills: ['保守開発', 'Java', 'テスト', 'Spring Boot', '基本設計'],
      budgetMin: null, budgetMax: 80,
      workLocation: '東京都 大森', remotePolicy: null,
      niceToHaveSkills: [],
    }
  },
]

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

async function runMatch(project) {
  console.log(`\n=== ${project.title} ===`)
  const candidates = JSON.parse(readFileSync(project.candidatesFile, 'utf8'))
  console.log(`  Candidates: ${candidates.length}`)

  const aiTargets = candidates.slice(0, BATCH_TOP_N)
  const ruleOnlyRest = candidates.slice(BATCH_TOP_N)

  // AI scoring for top 10
  let aiData
  try {
    aiData = await callMatchBatch(project.req, aiTargets, BATCH_TOP_N)
    console.log(`  usedModel: ${aiData.usedModel}`)
    console.log(`  AI results: ${aiData.results?.length ?? 0}`)
    if (aiData.results?.length > 0) {
      aiData.results.slice(0, 5).forEach(r => {
        console.log(`    score=${r.score} rule=${r.ruleScore} ${(r.summary ?? '').slice(0, 60)}`)
      })
    }
  } catch (e) {
    console.error('  AI call failed:', e.message)
    aiData = { results: [], ruleOnly: [], usedModel: 'rule' }
  }

  // Rule-only for the rest
  const ruleMap = new Map()
  const CHUNK = 20
  for (let i = 0; i < ruleOnlyRest.length; i += CHUNK) {
    const chunk = ruleOnlyRest.slice(i, i + CHUNK)
    try {
      const rData = await callMatchBatch(project.req, chunk, 0)
      for (const r of (rData.ruleOnly ?? [])) {
        ruleMap.set(r.id ?? r.candidateId, r)
      }
    } catch (e) {
      console.error(`  ruleOnly chunk ${i} failed:`, e.message)
    }
  }

  // Build result map
  const aiResultMap = new Map((aiData.results ?? []).map(r => [r.id ?? r.candidateId, r]))
  
  // Upsert submissions
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
      continue
    }

    const { error } = await supabase.from('submissions').upsert({
      candidate_id: c.id,
      project_id: project.id,
      data_env: 'prod',
      match_score: score,
      ai_summary: summary,
      status: 'pending',
      created_by: 'system',
      ai_raw: {
        ruleScore,
        breakdown,
        usedModel: aiData.usedModel,
        autoMatched: false,
        source: 'manual-rematch',
      }
    }, { onConflict: 'candidate_id,project_id' })

    if (error) { console.error('upsert error:', error.message.slice(0, 80)); errors++ }
    else inserted++
  }
  console.log(`  Upserted ${inserted} (${errors} errors)`)
}

for (const p of projects) {
  await runMatch(p)
}
console.log('\nDone!')
