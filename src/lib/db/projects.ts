import type { QueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import type { AnalyzeProjectResponse } from '../ai/types'

/** 案件リスト用 TanStack Query キー（同一キーで fetchAll / fetchOpen を混ぜるとキャッシュが食い違う） */
export const projectsQueryKeys = {
  all: ['projects', 'all'] as const,
  open: ['projects', 'open'] as const,
}

export function invalidateProjectLists(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all })
  queryClient.invalidateQueries({ queryKey: projectsQueryKeys.open })
}

/** DBの案件1件を、マッチングAI入力形式に変換 */
export function projectToMatchRequirements(project: Project): AnalyzeProjectResponse {
  return {
    title: project.title,
    client: project.client,
    description: project.description,
    requiredSkills: project.required_skills as string[],
    budgetMin: project.budget_min,
    budgetMax: project.budget_max,
    startDate: project.start_date,
    endDate: project.end_date,
    workLocation: project.work_location,
    remotePolicy: project.remote_policy,
    contractType: project.contract_type,
    headcount: project.headcount,
    workload: project.workload,
    settlementMin: project.settlement_min,
    settlementMax: project.settlement_max,
    roleSummary: project.role_summary,
    industry: project.industry,
    niceToHaveSkills: (project.raw_data?.niceToHaveSkills as string[] | undefined) ?? [],
  }
}

export interface Project {
  id: string
  title: string
  client: string | null
  description: string
  required_skills: string[]
  budget_min: number | null
  budget_max: number | null
  start_date: string | null
  end_date: string | null
  work_location: string | null
  remote_policy: string | null
  contract_type: string | null
  headcount: number | null
  workload: string | null
  settlement_min: number | null
  settlement_max: number | null
  role_summary: string | null
  industry: string | null
  raw_data: Record<string, unknown>
  status: 'open' | 'filled' | 'closed'
  created_by: string
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface InsertProjectInput {
  analyzed: AnalyzeProjectResponse
  rawText: string
  createdBy: string
}

/** 案件を新規登録する */
export async function insertProject(input: InsertProjectInput): Promise<Project> {
  const { analyzed, rawText, createdBy } = input

  const { data, error } = await supabase
    .from('projects')
    .insert({
      title: analyzed.title,
      client: analyzed.client,
      description: analyzed.description,
      required_skills: analyzed.requiredSkills,
      budget_min: analyzed.budgetMin,
      budget_max: analyzed.budgetMax,
      start_date: analyzed.startDate ?? null,
      end_date: analyzed.endDate ?? null,
      work_location: analyzed.workLocation ?? null,
      remote_policy: analyzed.remotePolicy ?? null,
      contract_type: analyzed.contractType ?? null,
      headcount: analyzed.headcount ?? null,
      workload: analyzed.workload ?? null,
      settlement_min: analyzed.settlementMin ?? null,
      settlement_max: analyzed.settlementMax ?? null,
      role_summary: analyzed.roleSummary ?? null,
      industry: analyzed.industry ?? null,
      raw_data: {
        text: rawText,
        niceToHaveSkills: analyzed.niceToHaveSkills ?? [],
      },
      created_by: createdBy,
    })
    .select()
    .single()

  if (error) throw new Error(`案件の登録に失敗しました: ${error.message}`)
  return data as Project
}

export interface UpdateProjectInput {
  id: string
  title: string
  client: string | null
  description: string
  required_skills: string[]
  budget_min: number | null
  budget_max: number | null
  start_date: string | null
  end_date: string | null
  work_location: string | null
  remote_policy: string | null
  contract_type: string | null
  headcount: number | null
  workload: string | null
  settlement_min: number | null
  settlement_max: number | null
  role_summary: string | null
  industry: string | null
  status: Project['status']
  raw_data: Record<string, unknown>
  updated_by: string
}

/** 案件を手動更新する（IDで直接UPDATE） */
export async function updateProject(input: UpdateProjectInput): Promise<Project> {
  const { id, ...rest } = input
  const { data, error } = await supabase
    .from('projects')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(`案件の更新に失敗しました: ${error.message}`)
  return data as Project
}

/** 案件を削除する */
export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id)

  if (error) throw new Error(`案件の削除に失敗しました: ${error.message}`)
}

/** ID一覧で案件を取得（マッチング履歴との突合用） */
export async function fetchProjectsByIds(ids: string[]): Promise<Project[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('projects').select('*').in('id', ids)

  if (error) throw new Error(`案件の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Project[]
}

/** 全案件を取得（open のみ） */
export async function fetchOpenProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`案件の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Project[]
}

/** 全案件を取得（全ステータス） */
export async function fetchAllProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`案件の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Project[]
}
