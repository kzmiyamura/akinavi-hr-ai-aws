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

export interface UpsertSubmissionInput {
  candidateId: string
  projectId: string
  matchResult: MatchResponse
  createdBy: string
  dataEnv?: DataEnv
}

/** マッチング結果を保存（同一ペアは上書き） */
export async function upsertSubmission(input: UpsertSubmissionInput): Promise<Submission> {
  const { candidateId, projectId, matchResult, createdBy, dataEnv = 'prod' } = input

  const { data, error } = await supabase
    .from('submissions')
    .upsert(
      {
        data_env: dataEnv,
        candidate_id: candidateId,
        project_id: projectId,
        match_score: matchResult.score,
        ai_summary: matchResult.summary,
        ai_raw: { duplicateSuspected: matchResult.duplicateSuspected },
        created_by: createdBy,
      },
      { onConflict: 'candidate_id,project_id' },
    )
    .select()
    .single()

  if (error) throw new Error(`提案履歴の保存に失敗しました: ${error.message}`)
  return data as Submission
}

/** 案件別・人材別のマッチング件数（一覧画面用） */
export interface SubmissionStats {
  countByProjectId: Record<string, number>
  countByCandidateId: Record<string, number>
}

export async function fetchSubmissionStats(dataEnv: DataEnv): Promise<SubmissionStats> {
  const { data, error } = await supabase
    .from('submissions')
    .select('project_id, candidate_id')
    .eq('data_env', dataEnv)

  if (error) throw new Error(`提案履歴の集計に失敗しました: ${error.message}`)

  const countByProjectId: Record<string, number> = {}
  const countByCandidateId: Record<string, number> = {}

  for (const row of data ?? []) {
    const pid = row.project_id as string
    const cid = row.candidate_id as string
    countByProjectId[pid] = (countByProjectId[pid] ?? 0) + 1
    countByCandidateId[cid] = (countByCandidateId[cid] ?? 0) + 1
  }

  return { countByProjectId, countByCandidateId }
}

/** 案件に対するマッチングランキングを取得（スコア降順） */
export async function fetchSubmissionsByProject(projectId: string, dataEnv: DataEnv): Promise<Submission[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('data_env', dataEnv)
    .eq('project_id', projectId)

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}

/** 複数案件のマッチング結果を一括取得（呼び出し側で project_id ごとに集約・スコア順に並べ替え） */
export async function fetchSubmissionsByProjectIds(projectIds: string[], dataEnv: DataEnv): Promise<Submission[]> {
  if (projectIds.length === 0) return []
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
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
    .select('*')
    .eq('data_env', dataEnv)
    .in('candidate_id', candidateIds)

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}

/** 人材に対するマッチング履歴を取得（スコア降順） */
export async function fetchSubmissionsByCandidate(candidateId: string, dataEnv: DataEnv): Promise<Submission[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
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
    .limit(5000)

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
