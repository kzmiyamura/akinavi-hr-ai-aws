// Supabase Edge Function: auto-match
// pg_cron から毎朝呼び出され、直近 24 時間に登録された案件と人材を自動マッチングする
//
// GET  （pg_cron / 手動テスト用）
//   → { ok: true, matched: number, skipped: number, errors: string[] }
//
// 必要な Supabase Secrets:
//   SUPABASE_URL              （自動設定）
//   SUPABASE_SERVICE_ROLE_KEY （自動設定）
//   ※ AI呼び出しは match-batch Edge Function 経由（Cerebras/Groq/Gemini フォールバック）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

/** 案件1件あたりのマッチング候補者上限（スキルフィルター後） */
const MAX_CANDIDATES_PER_PROJECT = 40

/** match-batch への1バッチあたりの最大候補者数 */
const BATCH_AI_SIZE = 20

/** マッチング対象とする案件の登録からの経過時間（時間） */
const TARGET_HOURS = 25 // 1時間の余裕を持って25時間

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface BatchResult {
  candidateId: string
  score: number
  summary: string
  method: 'ai' | 'rule'
  ruleScore: number
}

/** match-batch Edge Function を呼び出して候補者バッチを評価する */
async function matchBatchProjectToCandidates(
  supabase: ReturnType<typeof createClient>,
  projectRequirements: Record<string, unknown>,
  candidates: Array<{
    id: string; name: string; skills: string[]; experienceYears: number | null
    desiredRate: string | null; summary: string; remoteAvailable?: boolean | null; wantsFullRemote?: boolean | null; prefecture?: string | null
  }>,
): Promise<Map<string, { score: number; summary: string }>> {
  const resultMap = new Map<string, { score: number; summary: string }>()

  for (let i = 0; i < candidates.length; i += BATCH_AI_SIZE) {
    const chunk = candidates.slice(i, i + BATCH_AI_SIZE)
    const { data, error } = await supabase.functions.invoke('match-batch', {
      body: {
        mode: 'project_to_candidates',
        projectRequirements,
        candidates: chunk,
        topN: chunk.length,
      },
    })
    if (error) throw new Error(`match-batch呼び出し失敗: ${error.message}`)
    const all: BatchResult[] = [...(data?.results ?? []), ...(data?.ruleOnly ?? [])]
    for (const r of all) {
      resultMap.set(r.candidateId, { score: r.score, summary: r.summary })
    }
  }
  return resultMap
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startedAt = Date.now()
  const elapsed = () => `${Date.now() - startedAt}ms`

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // ---- auto-match が設定画面で無効化されている場合はスキップ ----
    const { data: configRow } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'auto_match_enabled')
      .maybeSingle()
    if (configRow?.value === 'false') {
      console.log('[auto-match] auto_match_enabled=false のためスキップ')
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'disabled' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

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

    // 全候補者を1回だけ取得（ループ外）
    // skills カラムが jsonb 型のため .overlaps() が使えないためJS側でフィルタリング
    // 新着・経験年数降順で取得し、slice(0, MAX_CANDIDATES_PER_PROJECT) で上位が最新・高経験者になるよう保証
    const { data: allCandidates, error: candErr } = await supabase
      .from('candidates')
      .select('id, name, email, phone, skills, experience_years, raw_profile')
      .eq('data_env', 'prod')
      .is('merged_into', null)
      .eq('duplicate_flag', false)
      .order('created_at', { ascending: false })
      .order('experience_years', { ascending: false, nullsFirst: false })
      .limit(500)

    if (candErr) throw new Error(`候補者取得エラー: ${candErr.message}`)

    let totalMatched = 0
    let totalSkipped = 0
    const errors: string[] = []

    // ---- 案件ごとにマッチング ----
    for (const project of projects) {
      try {
        const requiredSkills: string[] = Array.isArray(project.required_skills)
          ? project.required_skills.map(String).filter(Boolean)
          : []

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

        const projectReq: Record<string, unknown> = {
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

        const batchInputs = targets.map(c => {
          const rp = (c.raw_profile as Record<string, unknown>) ?? {}
          return {
            id: c.id,
            name: c.name,
            skills: Array.isArray(c.skills) ? c.skills.map(String) : [],
            experienceYears: c.experience_years ?? null,
            desiredRate: rp.desiredRate as string | null ?? null,
            summary: typeof rp.summary === 'string' ? rp.summary as string : '',
            remoteAvailable: rp.remoteAvailable as boolean | null ?? null,
            wantsFullRemote: rp.wantsFullRemote as boolean | null ?? null,
            prefecture: rp.prefecture as string | null ?? null,
            availableRegions: Array.isArray(rp.availableRegions) ? rp.availableRegions as string[] : null,
            preferredJobTypes: Array.isArray(rp.roles) ? rp.roles as string[] : null,
          }
        })

        let resultMap: Map<string, { score: number; summary: string }> = new Map()
        try {
          resultMap = await matchBatchProjectToCandidates(supabase, projectReq, batchInputs)
        } catch (batchErr) {
          const msg = `バッチマッチング失敗 project=${project.id}: ${String(batchErr)}`
          console.error(`[auto-match] ${msg}`)
          errors.push(msg)
        }

        for (const c of targets) {
          const r = resultMap.get(c.id)
          if (!r) continue
          const { error: upsertErr } = await supabase
            .from('submissions')
            .upsert(
              {
                data_env: 'prod',
                candidate_id: c.id,
                project_id: project.id,
                match_score: r.score,
                ai_summary: r.summary,
                ai_raw: { autoMatched: true, source: 'auto-match-cron', ruleScore: r.ruleScore },
                created_by: 'auto-match-cron',
              },
              { onConflict: 'candidate_id,project_id' },
            )

          if (upsertErr) {
            errors.push(`upsert失敗 (${c.id}x${project.id}): ${upsertErr.message}`)
          } else {
            totalMatched++
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
