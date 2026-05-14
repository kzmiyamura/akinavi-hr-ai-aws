import { supabase } from '../supabase'
import type { AnalyzeCandidateResponse, CandidateSkillsByCategory } from '../ai/types'
import type { DataEnv } from '../dataEnv'
import {
  normalizeCandidateSkillsByCategory,
  skillsByCategoryHasAny,
} from '../ai/types'

export interface Candidate {
  id: string
  data_env: DataEnv
  name: string
  email: string | null
  phone: string | null
  skills: string[]
  experience_years: number | null
  raw_profile: Record<string, unknown>
  duplicate_flag: boolean
  merged_into: string | null
  created_by: string
  updated_by: string | null
  created_at: string
  updated_at: string
  resume_url: string | null
  drive_url: string | null
  box_url: string | null
  box_status: string | null
  desired_rate: string | null
  from_company: string | null
}

export interface UpsertCandidateInput {
  analyzed: AnalyzeCandidateResponse
  rawText: string
  createdBy: string
  duplicateSuspected?: boolean
  dataEnv?: DataEnv
}

/**
 * 人材を登録または更新する
 * - email が同じ既存レコードがあれば UPDATE（上書き）
 * - email がない場合は常に INSERT
 * - AI が重複疑いと判断した場合は duplicate_flag=true をセット
 */
function buildCandidateRawProfile(rawText: string, analyzed: AnalyzeCandidateResponse): Record<string, unknown> {
  const sbc: CandidateSkillsByCategory | null =
    analyzed.skillsByCategory != null
      ? normalizeCandidateSkillsByCategory(analyzed.skillsByCategory)
      : null

  const profile: Record<string, unknown> = {
    text: rawText,
    summary: analyzed.summary,
  }
  if (sbc && skillsByCategoryHasAny(sbc)) {
    profile.skillsByCategory = sbc
  }
  if (analyzed.roles?.length) profile.roles = analyzed.roles
  if (analyzed.industries?.length) profile.industries = analyzed.industries
  if (analyzed.nearestStation != null) profile.nearestStation = analyzed.nearestStation
  if (analyzed.prefecture != null) profile.prefecture = analyzed.prefecture
  if (analyzed.availableRegions != null) profile.availableRegions = analyzed.availableRegions
  if (analyzed.currentWorkLocation != null) profile.currentWorkLocation = analyzed.currentWorkLocation
  if (analyzed.remoteAvailable != null) profile.remoteAvailable = analyzed.remoteAvailable
  return profile
}

export async function upsertCandidate(input: UpsertCandidateInput): Promise<Candidate> {
  const { analyzed, rawText, createdBy, duplicateSuspected = false, dataEnv = 'prod' } = input

  let skills = [...(analyzed.skills ?? [])].map((s) => s.trim()).filter(Boolean)
  if (skills.length === 0 && analyzed.skillsByCategory != null) {
    const sbc = normalizeCandidateSkillsByCategory(analyzed.skillsByCategory)
    if (skillsByCategoryHasAny(sbc)) {
      skills = [...new Map(Object.values(sbc).flat().map((s) => [s.toLowerCase(), s])).values()]
    }
  }

  const payload = {
    data_env: dataEnv,
    name: analyzed.name,
    email: analyzed.email,
    phone: analyzed.phone,
    skills,
    experience_years: analyzed.experienceYears,
    raw_profile: buildCandidateRawProfile(rawText, analyzed),
    duplicate_flag: duplicateSuspected,
    created_by: createdBy,
  }

  if (analyzed.email) {
    // email をキーに upsert（同一メールなら UPDATE）
    const { data, error } = await supabase
      .from('candidates')
      .upsert(payload, { onConflict: 'email' })
      .select()
      .single()

    if (error) throw new Error(`候補者の保存に失敗しました: ${error.message}`)
    return data as Candidate
  } else {
    // email なし → 新規 INSERT
    const { data, error } = await supabase
      .from('candidates')
      .insert(payload)
      .select()
      .single()

    if (error) throw new Error(`候補者の登録に失敗しました: ${error.message}`)
    return data as Candidate
  }
}

/** IDで1件取得（詳細画面用） */
export async function fetchCandidateById(id: string, dataEnv: DataEnv): Promise<Candidate | null> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('id', id)
    .eq('data_env', dataEnv)
    .maybeSingle()

  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return (data ?? null) as Candidate | null
}

/** 全候補者を取得（マージ済みを除外） */
export async function fetchCandidates(dataEnv: DataEnv): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('data_env', dataEnv)
    .is('merged_into', null)
    .order('updated_at', { ascending: false })
    .limit(500)

  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

export interface UpdateCandidateInput {
  id: string
  dataEnv: DataEnv
  name: string
  email: string | null
  phone: string | null
  experience_years: number | null
  duplicate_flag: boolean
  updated_by: string
  raw_profile: Record<string, unknown>
}

/** 候補者を手動更新する（IDで直接UPDATE） */
export async function updateCandidate(input: UpdateCandidateInput): Promise<Candidate> {
  const { id, dataEnv, ...rest } = input
  const { data, error } = await supabase
    .from('candidates')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('data_env', dataEnv)
    .select()
    .single()

  if (error) throw new Error(`候補者の更新に失敗しました: ${error.message}`)
  return data as Candidate
}

/** 候補者を削除する */
export async function deleteCandidate(id: string, dataEnv: DataEnv): Promise<void> {
  const { error } = await supabase
    .from('candidates')
    .delete()
    .eq('id', id)
    .eq('data_env', dataEnv)

  if (error) throw new Error(`候補者の削除に失敗しました: ${error.message}`)
}

/** duplicate_flag=true の候補者のみ取得 */
export async function fetchDuplicateCandidates(dataEnv: DataEnv): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('data_env', dataEnv)
    .eq('duplicate_flag', true)
    .is('merged_into', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`重複候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}
