import { supabase } from '../supabase'
import type { MatchResponse } from '../ai/types'
import { fetchProjectsByIds } from './projects'
import type { Project } from './projects'
import type { DataEnv } from '../dataEnv'

export interface Submission {
  id: string
  data_env: DataEnv
  candidate_id: string
  project_id: string
  match_score: number
  ai_summary: string
  ai_raw: Record<string, unknown>
  status: 'pending' | 'sent' | 'accepted' | 'rejected'
  created_by: string
  created_at: string
  updated_at: string
}

/**
 * 一覧・ランキングで引く列。`*` にしない。
 * 列が増えたときに黙って転送量が増えるのを防ぐ（ai_raw は breakdown と
 * recommendation を画面で使うので必要）。
 */
const SUBMISSION_COLUMNS =
  'id,data_env,candidate_id,project_id,match_score,ai_summary,ai_raw,status,created_by,created_at,updated_at'

export interface UpsertSubmissionInput {
  candidateId: string
  projectId: string
  matchResult: MatchResponse
  createdBy: string
  dataEnv?: DataEnv
  breakdown?: string
}

/** マッチング結果を保存（同一ペアは上書き） */
export async function upsertSubmission(input: UpsertSubmissionInput): Promise<Submission> {
  const { candidateId, projectId, matchResult, createdBy, dataEnv = 'prod', breakdown } = input

  const { data, error } = await supabase
    .from('submissions')
    .upsert(
      {
        data_env: dataEnv,
        candidate_id: candidateId,
        project_id: projectId,
        match_score: matchResult.score,
        ai_summary: matchResult.summary,
        ai_raw: {
          duplicateSuspected: matchResult.duplicateSuspected,
          ...(matchResult.ruleScore !== undefined && { ruleScore: matchResult.ruleScore }),
          ...(breakdown && { breakdown }),
        },
        created_by: createdBy,
      },
      { onConflict: 'candidate_id,project_id' },
    )
    .select()
    .single()

  if (error) throw new Error(`提案履歴の保存に失敗しました: ${error.message}`)
  return data as Submission
}

/** 1リクエストあたりの保存件数。全件モードで 500 件を1件ずつ往復すると数十秒かかる */
const SUBMISSION_UPSERT_CHUNK = 200

/**
 * マッチング結果をまとめて保存（同一ペアは上書き）。
 * 保存後の行は使わないので select しない（戻りぶんの転送を丸ごと省く）
 */
export async function upsertSubmissions(inputs: UpsertSubmissionInput[]): Promise<void> {
  for (let i = 0; i < inputs.length; i += SUBMISSION_UPSERT_CHUNK) {
    const chunk = inputs.slice(i, i + SUBMISSION_UPSERT_CHUNK).map(input => {
      const { candidateId, projectId, matchResult, createdBy, dataEnv = 'prod', breakdown } = input
      return {
        data_env: dataEnv,
        candidate_id: candidateId,
        project_id: projectId,
        match_score: matchResult.score,
        ai_summary: matchResult.summary,
        ai_raw: {
          duplicateSuspected: matchResult.duplicateSuspected,
          ...(matchResult.ruleScore !== undefined && { ruleScore: matchResult.ruleScore }),
          ...(breakdown && { breakdown }),
        },
        created_by: createdBy,
      }
    })
    const { error } = await supabase
      .from('submissions')
      .upsert(chunk, { onConflict: 'candidate_id,project_id' })
    if (error) throw new Error(`提案履歴の保存に失敗しました: ${error.message}`)
  }
}

/**
 * 案件別・人材別のマッチング件数（一覧画面用）
 * ai* は AI が採点・理由付けした件数。高速モードでは上位N名だけなので、
 * 「保存件数」と「AI採点件数」は必ず分けて出す
 */
export interface SubmissionStats {
  countByProjectId: Record<string, number>
  countByCandidateId: Record<string, number>
  aiCountByProjectId: Record<string, number>
  aiCountByCandidateId: Record<string, number>
}

interface SubmissionCountRow {
  kind: 'project' | 'candidate'
  ref_id: string
  n: number
  n_ai: number
}

/**
 * 集計は SQL 側（submission_counts RPC）でやる。
 * 以前は submissions を全行引いて JS で数えていたが、PostgREST の既定上限 1000 行で
 * 黙って頭打ちになり、502 件ある案件が「308件」と表示されていた（2026-08-13）
 */
export async function fetchSubmissionStats(dataEnv: DataEnv): Promise<SubmissionStats> {
  const { data, error } = await supabase.rpc('submission_counts', { p_data_env: dataEnv })

  if (error) throw new Error(`提案履歴の集計に失敗しました: ${error.message}`)

  const stats: SubmissionStats = {
    countByProjectId: {},
    countByCandidateId: {},
    aiCountByProjectId: {},
    aiCountByCandidateId: {},
  }

  for (const row of (data ?? []) as SubmissionCountRow[]) {
    const n = Number(row.n) || 0
    const nAi = Number(row.n_ai) || 0
    if (row.kind === 'project') {
      stats.countByProjectId[row.ref_id] = n
      stats.aiCountByProjectId[row.ref_id] = nAi
    } else {
      stats.countByCandidateId[row.ref_id] = n
      stats.aiCountByCandidateId[row.ref_id] = nAi
    }
  }

  return stats
}

/** 案件に対するマッチングランキングを取得（スコア降順） */
export async function fetchSubmissionsByProject(projectId: string, dataEnv: DataEnv, limit = 200): Promise<Submission[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('data_env', dataEnv)
    .eq('project_id', projectId)
    .order('match_score', { ascending: false })
    .limit(limit)

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}

/** 複数案件のマッチング結果を一括取得（呼び出し側で project_id ごとに集約・スコア順に並べ替え） */
export async function fetchSubmissionsByProjectIds(projectIds: string[], dataEnv: DataEnv): Promise<Submission[]> {
  if (projectIds.length === 0) return []
  const { data, error } = await supabase
    .from('submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('data_env', dataEnv)
    .in('project_id', projectIds)

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}

/** 複数人材のマッチング結果を一括取得（呼び出し側で candidate_id ごとに集約・スコア順に並べ替え） */
export async function fetchSubmissionsByCandidateIds(candidateIds: string[], dataEnv: DataEnv): Promise<Submission[]> {
  if (candidateIds.length === 0) return []
  const { data, error } = await supabase
    .from('submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('data_env', dataEnv)
    .in('candidate_id', candidateIds)

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}

/** 人材ID → 提案の件数と状態。**一覧のバッジ用に列を絞った軽い版**。
 *
 *  fetchSubmissionsByCandidateIds は ai_raw（AI の生出力）まで引くので、
 *  100人ぶん取ると転送量が跳ねる。バッジに要るのは件数と状態だけ。
 *  営業が「この人もう提案したっけ」を毎回思い出していたのを画面で解決する。 */
/** バッジが指している提案先。
 *  **どの案件に対してかが画面に無いと「提案候補4」の 4 が読めない**（2026-10-19 指摘）。 */
export interface SubmissionBadgeProject {
  projectId: string
  /** 案件が消えていれば '(削除された案件)'。prod 実測では 117件すべて生きている（2026-10-19） */
  title: string
  status: Submission['status']
  /** 最後に動いた日時。古いマッチング結果が残っているだけなのかを見分ける */
  at: string
}
export interface SubmissionBadge {
  /** 提案の総数＝この人が候補に挙がっている案件の数（同一ペアは上書きなので案件数と一致する） */
  count: number
  /** 一番進んでいる状態。accepted > sent > pending > rejected の順で採る */
  best: Submission['status']
  /** 進んでいる順・新しい順。先頭がバッジに出る1件 */
  projects: SubmissionBadgeProject[]
}

const SUBMISSION_RANK: Record<Submission['status'], number> = {
  accepted: 3, sent: 2, pending: 1, rejected: 0,
}

export async function fetchSubmissionBadges(
  candidateIds: string[],
  dataEnv: DataEnv,
): Promise<Map<string, SubmissionBadge>> {
  const out = new Map<string, SubmissionBadge>()
  if (candidateIds.length === 0) return out
  // ⚠ 案件名は submissions に埋め込み select（projects(title)）で取らない。
  //    同じ案件名が行数ぶん繰り返されるため。prod 実測（2026-10-19・117行）で
  //    埋め込みは 31.3KB、ここで使う「ID だけ＋案件名を別に1回」は 15.6KB。
  //    提案は案件12件に対して117行＝1案件あたり約10行なので、繰り返すほど無駄になる。
  const { data, error } = await supabase
    .from('submissions')
    .select('candidate_id,status,project_id,updated_at')
    .eq('data_env', dataEnv)
    .in('candidate_id', candidateIds)
  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  const rows = (data ?? []) as Array<{
    candidate_id: string; status: Submission['status']; project_id: string; updated_at: string
  }>
  if (rows.length === 0) return out

  // 案件名は実体のぶんだけ。prod は12案件＝約1.5KB
  const titles = new Map<string, string>()
  const projectIds = [...new Set(rows.map((r) => r.project_id))]
  const { data: projects } = await supabase
    .from('projects')
    .select('id,title')
    .in('id', projectIds)
  for (const p of (projects ?? []) as Array<{ id: string; title: string | null }>) {
    titles.set(p.id, (p.title ?? '').trim() || '（案件名なし）')
  }

  for (const row of rows) {
    const entry: SubmissionBadgeProject = {
      projectId: row.project_id,
      // 案件は ON DELETE CASCADE なので普通は消えないが、取れなかったことを隠さない
      title: titles.get(row.project_id) ?? '（削除された案件）',
      status: row.status,
      at: row.updated_at,
    }
    const cur = out.get(row.candidate_id)
    if (!cur) out.set(row.candidate_id, { count: 1, best: row.status, projects: [entry] })
    else {
      cur.count++
      cur.projects.push(entry)
      if (SUBMISSION_RANK[row.status] > SUBMISSION_RANK[cur.best]) cur.best = row.status
    }
  }
  // 進んでいる順 → 新しい順。バッジに出す1件を決めるのと、詳細の並びを兼ねる
  for (const badge of out.values()) {
    badge.projects.sort((a, b) =>
      SUBMISSION_RANK[b.status] - SUBMISSION_RANK[a.status] || b.at.localeCompare(a.at))
  }
  return out
}

/** 人材に対するマッチング履歴を取得（スコア降順） */
export async function fetchSubmissionsByCandidate(candidateId: string, dataEnv: DataEnv): Promise<Submission[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('data_env', dataEnv)
    .eq('candidate_id', candidateId)

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}

export interface SubmissionWithProject {
  submission: Submission
  project: Project | null
}

/** 人材のマッチング一覧（案件マスタを結合。削除済み等は project が null） */
export async function fetchSubmissionsByCandidateWithProjects(
  candidateId: string,
  dataEnv: DataEnv,
): Promise<SubmissionWithProject[]> {
  const submissions = await fetchSubmissionsByCandidate(candidateId, dataEnv)
  const ids = [...new Set(submissions.map((s) => s.project_id))]
  const projects = await fetchProjectsByIds(ids, dataEnv)
  const map = new Map(projects.map((p) => [p.id, p]))
  return submissions.map((submission) => ({
    submission,
    project: map.get(submission.project_id) ?? null,
  }))
}

/** 一覧の「上位プレビュー」用（案件名・人材名を FK 参照で取得） */
export interface SubmissionListPreviewRow {
  project_id: string
  candidate_id: string
  match_score: number
  project_title: string | null
  candidate_name: string | null
}

export async function fetchSubmissionsListPreview(dataEnv: DataEnv): Promise<SubmissionListPreviewRow[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select(
      `
    project_id,
    candidate_id,
    match_score,
    projects ( title ),
    candidates ( name )
  `,
    )
    .eq('data_env', dataEnv)
    .limit(500)

  if (error) throw new Error(`マッチング一覧プレビューの取得に失敗しました: ${error.message}`)

  function pickTitle(projects: unknown): string | null {
    if (projects == null) return null
    if (Array.isArray(projects)) {
      const first = projects[0] as { title?: string } | undefined
      return first?.title ?? null
    }
    const o = projects as { title?: string }
    return o.title ?? null
  }

  function pickName(candidates: unknown): string | null {
    if (candidates == null) return null
    if (Array.isArray(candidates)) {
      const first = candidates[0] as { name?: string } | undefined
      return first?.name ?? null
    }
    const o = candidates as { name?: string }
    return o.name ?? null
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    project_id: String(row.project_id),
    candidate_id: String(row.candidate_id),
    match_score: Number(row.match_score),
    project_title: pickTitle(row.projects),
    candidate_name: pickName(row.candidates),
  }))
}

const PREVIEW_TOP_N = 3

export function topSubmissionsPerProject(
  rows: SubmissionListPreviewRow[],
  topN: number = PREVIEW_TOP_N,
): Map<string, SubmissionListPreviewRow[]> {
  const groups = new Map<string, SubmissionListPreviewRow[]>()
  for (const r of rows) {
    const list = groups.get(r.project_id) ?? []
    list.push(r)
    groups.set(r.project_id, list)
  }
  const out = new Map<string, SubmissionListPreviewRow[]>()
  for (const [pid, list] of groups) {
    list.sort((a, b) => b.match_score - a.match_score)
    out.set(pid, list.slice(0, topN))
  }
  return out
}

export function topSubmissionsPerCandidate(
  rows: SubmissionListPreviewRow[],
  topN: number = PREVIEW_TOP_N,
): Map<string, SubmissionListPreviewRow[]> {
  const groups = new Map<string, SubmissionListPreviewRow[]>()
  for (const r of rows) {
    const list = groups.get(r.candidate_id) ?? []
    list.push(r)
    groups.set(r.candidate_id, list)
  }
  const out = new Map<string, SubmissionListPreviewRow[]>()
  for (const [cid, list] of groups) {
    list.sort((a, b) => b.match_score - a.match_score)
    out.set(cid, list.slice(0, topN))
  }
  return out
}

/**
 * 提案の状態を人が動かす（提案済・見送り・取り消し）。#191・2026-10-20。
 *
 * 遷移の判定は `src/lib/submissionAction.ts`（画面と共用）。ここは書き込みだけ。
 * ⚠ 参画確定（accepted）は `MatchingPage` の decideMutation が担う。
 *    あちらは同一人材の他案件を一括で rejected にするので、ここでは扱わない。
 */
export async function updateSubmissionStatus(
  id: string,
  status: Submission['status'],
  dataEnv: DataEnv,
): Promise<void> {
  const { error } = await supabase
    .from('submissions')
    .update({ status })
    .eq('id', id)
    .eq('data_env', dataEnv)
  if (error) throw new Error(`提案の状態の更新に失敗しました: ${error.message}`)
}

/** 全マッチング結果を削除する（data_env 単位） */
export async function deleteAllSubmissions(dataEnv: DataEnv): Promise<number> {
  const { count, error } = await supabase
    .from('submissions')
    .delete({ count: 'exact' })
    .eq('data_env', dataEnv)

  if (error) throw new Error(`全マッチング結果の削除に失敗しました: ${error.message}`)
  return count ?? 0
}
