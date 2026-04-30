import { supabase } from '../supabase'
import type { MatchResponse } from '../ai/types'

export interface Submission {
  id: string
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
}

/** マッチング結果を保存（同一ペアは上書き） */
export async function upsertSubmission(input: UpsertSubmissionInput): Promise<Submission> {
  const { candidateId, projectId, matchResult, createdBy } = input

  const { data, error } = await supabase
    .from('submissions')
    .upsert(
      {
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

/** 案件に対するマッチングランキングを取得（スコア降順） */
export async function fetchSubmissionsByProject(projectId: string): Promise<Submission[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('project_id', projectId)
    .order('match_score', { ascending: false })

  if (error) throw new Error(`提案履歴の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Submission[]
}
