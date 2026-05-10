// Supabase Edge Function: auto-match
// pg_cron から毎朝呼び出され、直近 24 時間に登録された案件と人材を自動マッチングする
//
// GET  （pg_cron / 手動テスト用）
//   → { ok: true, matched: number, skipped: number, errors: string[] }
//
// 必要な Supabase Secrets:
//   GEMINI_API_KEY
//   SUPABASE_URL              （自動設定）
//   SUPABASE_SERVICE_ROLE_KEY （自動設定）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'npm:@google/generative-ai@0.21.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''

/** 案件1件あたりのマッチング候補者上限（スキルフィルター後） */
const MAX_CANDIDATES_PER_PROJECT = 40

/** マッチング対象とする案件の登録からの経過時間（時間） */
const TARGET_HOURS = 25 // 1時間の余裕を持って25時間

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface MatchResult {
  score: number
  summary: string
  duplicateSuspected: boolean
}

/** Gemini でマッチングスコアを算出する */
async function matchCandidateToProject(
  candidateProfile: Record<string, unknown>,
  projectRequirements: Record<string, unknown>,
): Promise<MatchResult> {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `
あなたはマッチング判定AIです。以下の「人材」と「案件」を読み、マッチング結果を JSON だけで返してください。
余分な説明文・コードブロックは禁止です。

人材:
${JSON.stringify(candidateProfile, null, 2)}

案件:
${JSON.stringify(projectRequirements, null, 2)}

返却 JSON フィールド:
- score: number（0〜100）
- summary: string（理由を200字以内）
- duplicateSuspected: boolean（人材が既存と非常に似ている場合true）

JSON:`.trim()

  const result = await model.generateContent(prompt)
  const text = result.response.text().trim()

  // JSON部分を抽出
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`Gemini応答がJSONでない: ${text.slice(0, 100)}`)

  const r = JSON.parse(jsonMatch[0]) as Partial<MatchResult>
  const score = typeof r.score === 'number' ? r.score : Number(r.score ?? 0)
  return {
    score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
    summary: typeof r.summary === 'string' ? r.summary : '',
    duplicateSuspected: Boolean(r.duplicateSuspected),
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startedAt = Date.now()
  const elapsed = () => `${Date.now() - startedAt}ms`

  try {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です')

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    console.log('[auto-match] 開始')

    // ---- 対象案件を取得（直近25時間以内に登録 + data_env=prod） ----
    const since = new Date(Date.now() - TARGET_HOURS * 60 * 60 * 1000).toISOString()

    const { data: projects, error: projectsErr } = await supabase
      .from('projects')
      .select('id, title, client, description, required_skills, budget_min, budget_max, work_location, remote_policy, contract_type, role_summary, industry, raw_data, data_env')
      .eq('data_env', 'prod')
      .gte('created_at', since)

    if (projectsErr) throw new Error(`案件取得エラー: ${projectsErr.message}`)

    console.log(`[auto-match] 対象案件: ${(projects ?? []).length}件 (since ${since})`)

    if (!projects || projects.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, matched: 0, skipped: 0, errors: [], message: '対象案件なし' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ---- 既に submissions がある (candidate_id, project_id) ペアを取得してスキップ ----
    const projectIds = projects.map(p => p.id)
    const { data: existingSubmissions } = await supabase
      .from('submissions')
      .select('candidate_id, project_id')
      .in('project_id', projectIds)
      .eq('data_env', 'prod')

    const existingPairs = new Set<string>(
      (existingSubmissions ?? []).map(s => `${s.candidate_id}:${s.project_id}`)
    )

    // ---- 参画確定済み（accepted）の人材はマッチング対象から除外 ----
    const { data: acceptedRows } = await supabase
      .from('submissions')
      .select('candidate_id')
      .eq('data_env', 'prod')
      .eq('status', 'accepted')
      .limit(10000)

    const acceptedIds = new Set<string>(
      (acceptedRows ?? []).map(r => String((r as { candidate_id: string }).candidate_id))
    )

    let totalMatched = 0
    let totalSkipped = 0
    const errors: string[] = []

    // ---- 案件ごとにマッチング ----
    for (const project of projects) {
      try {
        const requiredSkills: string[] = Array.isArray(project.required_skills)
          ? project.required_skills.map(String).filter(Boolean)
          : []

        // 全候補者を取得してJS側でスキル重複フィルター
        // （skills カラムが jsonb 型のため .overlaps() が使えないため JS でフィルタリング）
        const { data: allCandidates, error: candErr } = await supabase
          .from('candidates')
          .select('id, name, email, phone, skills, experience_years, raw_profile')
          .eq('data_env', 'prod')
          .is('merged_into', null)
          .limit(500)

        if (candErr) throw new Error(`候補者取得エラー: ${candErr.message}`)

        // スキル重複フィルター（大文字小文字を無視した部分一致）
        const skillFiltered = requiredSkills.length > 0
          ? (allCandidates ?? []).filter(c => {
              const cSkills: string[] = Array.isArray(c.skills) ? c.skills.map(String) : []
              return requiredSkills.some(r =>
                cSkills.some(s =>
                  s.toLowerCase().includes(r.toLowerCase()) ||
                  r.toLowerCase().includes(s.toLowerCase())
                )
              )
            })
          : (allCandidates ?? [])

        const targets = skillFiltered
          .filter(c =>
            !acceptedIds.has(String(c.id)) &&
            !existingPairs.has(`${c.id}:${project.id}`)
          )
          .slice(0, MAX_CANDIDATES_PER_PROJECT)

        console.log(`[auto-match] 案件「${project.title}」: スキルフィルター後=${targets.length}名`)

        const projectReq = {
          title: project.title,
          client: project.client,
          description: project.description,
          requiredSkills,
          niceToHaveSkills: Array.isArray(project.raw_data?.niceToHaveSkills)
            ? project.raw_data.niceToHaveSkills.map(String)
            : [],
          budgetMin: project.budget_min ?? null,
          budgetMax: project.budget_max ?? null,
          workLocation: project.work_location ?? null,
          remotePolicy: project.remote_policy ?? null,
          contractType: project.contract_type ?? null,
          roleSummary: project.role_summary ?? null,
          industry: project.industry ?? null,
        }

        for (const c of targets) {
          try {
            const candidateProfile = {
              name: c.name,
              email: c.email ?? null,
              skills: c.skills ?? [],
              experienceYears: c.experience_years ?? null,
              summary: typeof c.raw_profile?.summary === 'string' ? c.raw_profile.summary : '',
            }

            const mr = await matchCandidateToProject(candidateProfile, projectReq)

            const { error: upsertErr } = await supabase
              .from('submissions')
              .upsert(
                {
                  data_env: 'prod',
                  candidate_id: c.id,
                  project_id: project.id,
                  match_score: mr.score,
                  ai_summary: mr.summary,
                  ai_raw: { duplicateSuspected: mr.duplicateSuspected, autoMatched: true, source: 'auto-match-cron' },
                  created_by: 'auto-match-cron',
                },
                { onConflict: 'candidate_id,project_id' },
              )

            if (upsertErr) {
              errors.push(`upsert失敗 (${c.id}x${project.id}): ${upsertErr.message}`)
            } else {
              totalMatched++
            }
          } catch (pairErr) {
            const msg = `マッチング失敗 candidate=${c.id} project=${project.id}: ${String(pairErr)}`
            console.error(`[auto-match] ${msg}`)
            errors.push(msg)
          }
        }

        totalSkipped += (allCandidates ?? []).length - targets.length
      } catch (projErr) {
        const msg = `案件処理失敗 project=${project.id}: ${String(projErr)}`
        console.error(`[auto-match] ${msg}`)
        errors.push(msg)
      }
    }

    console.log(`[auto-match] 完了: matched=${totalMatched} skipped=${totalSkipped} errors=${errors.length} elapsed=${elapsed()}`)

    return new Response(
      JSON.stringify({ ok: true, matched: totalMatched, skipped: totalSkipped, errors }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[auto-match] 致命的エラー', e)
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
