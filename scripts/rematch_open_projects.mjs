/**
 * rematch_open_projects.mjs
 * 全 open 案件 × 現在の候補者（直近7日）に対して match-batch を再実行し
 * submissions を upsert する。新スコアリング（英語要件・雇用形態・派遣免許）を反映。
 *
 * Usage:
 *   node scripts/rematch_open_projects.mjs [--dry-run] [--project <id先頭一致>]
 *
 * --project を付けると1案件だけ回す（id は先頭一致で可）。
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// .env.local を手動パース（dotenv 不要）
// CRLF のまま split('\n') すると行末に \r が残り、`.` は \r にマッチしないので
// /^([^#=]+)=(.*)$/ が全行外れる（＝env が空のまま起動する）
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1`

// anon ロールは statement_timeout（既定8秒）が短く、必須スキルが広い案件だと
// fetch_candidates_for_project（実測10秒超）が毎回切られる。バッチは service_role で回す。
const USE_SERVICE = process.argv.includes('--service')
let dbKey = ANON_KEY
if (USE_SERVICE) {
  const wt = readFileSync(new URL('.akinavi_shadow.env', `file:///${process.env.USERPROFILE.replace(/\\/g, '/')}/`), 'utf8')
  for (const line of wt.split(/\r?\n/)) {
    const m = line.match(/^\s*export\s+([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  dbKey = process.env.SUPABASE_SERVICE_KEY
}
const supabase = createClient(SUPABASE_URL, dbKey)

const DEFAULT_WEIGHTS = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }
const BATCH_TOP_N = 10
const CANDIDATE_LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  return i >= 0 ? Number(process.argv[i + 1]) : 500
})()
const DATA_ENV = 'prod'
const DRY_RUN = process.argv.includes('--dry-run')
const PROJECT_FILTER = (() => {
  const i = process.argv.indexOf('--project')
  return i >= 0 ? process.argv[i + 1] ?? null : null
})()

// ── 候補者 → match-batch 入力変換 ──────────────────────────────────────────
function toCandidateBatchInput(c, agentMap) {
  const rp = c.raw_profile ?? {}
  const employmentType = rp.employmentType ?? null
  let hakenLicenseVerified = null
  if (employmentType === '派遣社員') {
    const email = c.email ?? rp.email ?? ''
    const domain = email.includes('@') ? email.split('@')[1] : null
    if (domain && agentMap) {
      const ls = agentMap.get(domain)?.license_status ?? null
      if (ls === 'haken' || ls === 'both') hakenLicenseVerified = true
      else if (ls === 'none' || ls === 'shokai') hakenLicenseVerified = false
    }
  }
  return {
    id: c.id,
    name: c.name,
    skills: Array.isArray(c.skills) ? c.skills : [],
    experienceYears: c.experience_years,
    desiredRate: c.desired_rate ?? rp.desiredRate ?? null,
    summary: rp.summary ?? '',
    remoteAvailable: rp.remoteAvailable ?? null,
    wantsFullRemote: rp.wantsFullRemote ?? null,
    prefecture: rp.prefecture ?? null,
    availableRegions: Array.isArray(rp.availableRegions) ? rp.availableRegions : null,
    preferredJobTypes: Array.isArray(rp.roles) ? rp.roles : null,
    // 役割の加減点用（match-batch は roles[0] を主役割として見る）。
    // preferredJobTypes とは別のフィールドなので両方渡す（2026-08-14）
    roles: Array.isArray(rp.roles) ? rp.roles : null,
    agentComment: rp.agentComment ?? null,
    nationality: rp.nationality ?? null,
    selfPR: rp.selfPR ?? null,
    skillYears: rp.skillYears ?? null,
    desiredProject: rp.desiredProject ?? null,
    employmentType,
    hakenLicenseVerified,
  }
}

// ── 案件 → match-batch 入力変換 ──────────────────────────────────────────────
function toProjectReq(p) {
  const raw = p.raw_data ?? {}
  return {
    title: p.title,
    client: p.client ?? null,
    description: p.description ?? '',
    requiredSkills: Array.isArray(p.required_skills) ? p.required_skills : [],
    niceToHaveSkills: Array.isArray(raw.niceToHaveSkills) ? raw.niceToHaveSkills : [],
    budgetMin: p.budget_min ?? null,
    budgetMax: p.budget_max ?? null,
    workLocation: p.work_location ?? null,
    remotePolicy: p.remote_policy ?? null,
    contractType: p.contract_type ?? null,
    // 案件が求める役割（AI解釈）。渡さないと match-batch 側が中立扱いになり
    // 役割の加減点が丸ごと効かない（2026-08-14）
    requiredRole: raw.aiInterpretation?.requiredRole ?? null,
    roleSummary: p.role_summary ?? null,
    industry: p.industry ?? null,
    requiresEnglish: raw.requiresEnglish ?? 'none',
    allowedEmploymentTypes: Array.isArray(raw.allowedEmploymentTypes) ? raw.allowedEmploymentTypes : null,
  }
}

// ── match-batch 呼び出し ──────────────────────────────────────────────────────
async function callMatchBatch(projectReq, candidates, topN) {
  const resp = await fetch(`${EDGE_URL}/match-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
    body: JSON.stringify({
      mode: 'project_to_candidates',
      projectRequirements: projectReq,
      candidates,
      weights: DEFAULT_WEIGHTS,
      topN,
    }),
  })
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`)
  return resp.json()
}

// ── メイン ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== rematch_open_projects ${DRY_RUN ? '[DRY-RUN]' : ''} ===`)

  // agent_companies をロード
  const { data: agentRows } = await supabase.from('agent_companies').select('domain, license_status')
  const agentMap = new Map((agentRows ?? []).map(r => [r.domain, r]))
  console.log(`agent_companies: ${agentMap.size} 件`)

  // open 案件を全取得
  const { data: allProjects, error: pErr } = await supabase
    .from('projects')
    .select('*')
    .eq('data_env', DATA_ENV)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
  if (pErr) throw new Error(pErr.message)
  const projects = PROJECT_FILTER
    ? allProjects.filter(p => p.id.startsWith(PROJECT_FILTER))
    : allProjects
  if (PROJECT_FILTER && projects.length === 0) {
    throw new Error(`--project ${PROJECT_FILTER} に一致する open 案件がない`)
  }
  console.log(`open 案件: ${projects.length} 件${PROJECT_FILTER ? `（--project ${PROJECT_FILTER} で絞り込み）` : ''}\n`)

  let totalUpserted = 0, totalErrors = 0

  for (const project of projects) {
    const projectReq = toProjectReq(project)
    console.log(`── ${project.title} (${project.id.slice(0, 8)})`)

    // 候補者を RPC で取得
    const { data: candidates, error: cErr } = await supabase.rpc('fetch_candidates_for_project', {
      p_data_env:        DATA_ENV,
      p_required_skills: Array.isArray(project.required_skills) ? project.required_skills : [],
      p_budget_min:      project.budget_min ?? null,
      p_budget_max:      project.budget_max ?? null,
      p_work_location:   project.work_location ?? null,
      p_remote_policy:   project.remote_policy ?? null,
      p_limit:           CANDIDATE_LIMIT,
      p_weight_skill:    DEFAULT_WEIGHTS.skill,
      p_weight_exp:      DEFAULT_WEIGHTS.exp,
      p_weight_rate:     DEFAULT_WEIGHTS.rate,
      p_weight_location: DEFAULT_WEIGHTS.location,
      p_weight_remote:   DEFAULT_WEIGHTS.remote,
      p_require_haken:   false,
      // 画面（src/lib/db/candidates.ts）と同じ引数を渡す。
      // 省略すると古い13引数版のオーバーロードに落ちて結果が食い違う
      p_work_prefecture:    project.work_prefecture ?? null,
      p_required_exp_years: project.required_experience_years ?? null,
      p_skill_weights:      project.skill_weights ?? null,
      // 尚可スキルと役割も画面と揃える。渡していなかったので、この script だけ
      // 候補者の顔ぶれが画面と食い違っていた（2026-08-14 に発見）
      p_nice_skills:        Array.isArray(project.raw_data?.niceToHaveSkills)
        ? project.raw_data.niceToHaveSkills : null,
      p_required_role:      project.raw_data?.aiInterpretation?.requiredRole ?? null,
    })
    if (cErr) { console.error('  candidates 取得失敗:', cErr.message); continue }
    if (!candidates || candidates.length === 0) { console.log('  候補者なし スキップ'); continue }
    console.log(`  候補者: ${candidates.length} 件`)

    const candidateInputs = candidates.map(c => toCandidateBatchInput(c, agentMap))
    const aiTargets = candidateInputs.slice(0, BATCH_TOP_N)
    const ruleOnlyRest = candidateInputs.slice(BATCH_TOP_N)

    // AI 採点（上位 BATCH_TOP_N 件）
    let aiData = { results: [], ruleOnly: [], usedModel: 'rule' }
    try {
      aiData = await callMatchBatch(projectReq, aiTargets, BATCH_TOP_N)
      console.log(`  usedModel: ${aiData.usedModel} / AI: ${aiData.results?.length ?? 0} 件`)
    } catch (e) {
      console.error('  AI 失敗:', e.message.slice(0, 80))
    }

    // ルールのみ（残り）
    const ruleMap = new Map()
    const CHUNK = 20
    for (let i = 0; i < ruleOnlyRest.length; i += CHUNK) {
      const chunk = ruleOnlyRest.slice(i, i + CHUNK)
      try {
        const rData = await callMatchBatch(projectReq, chunk, 0)
        for (const r of (rData.ruleOnly ?? [])) ruleMap.set(r.id ?? r.candidateId, r)
      } catch (e) {
        console.error(`  ruleOnly chunk ${i} 失敗:`, e.message.slice(0, 60))
      }
    }

    const aiResultMap = new Map((aiData.results ?? []).map(r => [r.id ?? r.candidateId, r]))

    // Upsert
    let upserted = 0, errors = 0
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

      if (DRY_RUN) {
        // 役割の加減点が効いているかを目視できるように内訳から抜き出して出す
        const roleNote = (breakdown.match(/\[役割[^\]]*\]/) ?? [''])[0]
        console.log(`  [DRY] ${c.name} score=${score} rule=${ruleScore} ${roleNote}`)
        upserted++
        continue
      }

      const { error } = await supabase.from('submissions').upsert({
        candidate_id: c.id,
        project_id: project.id,
        data_env: DATA_ENV,
        match_score: score,
        ai_summary: summary,
        status: 'pending',
        created_by: 'system',
        ai_raw: {
          ruleScore,
          breakdown,
          usedModel: aiData.usedModel,
          autoMatched: false,
          source: 'rematch-script',
        },
      }, { onConflict: 'candidate_id,project_id', ignoreDuplicates: false })

      if (error) { console.error('  upsert error:', error.message.slice(0, 80)); errors++ }
      else upserted++
    }
    console.log(`  upserted: ${upserted} / errors: ${errors}`)
    totalUpserted += upserted
    totalErrors += errors
  }

  console.log(`\n完了: 合計 ${totalUpserted} 件更新 / ${totalErrors} 件エラー`)
}

main().catch(e => { console.error(e); process.exit(1) })
