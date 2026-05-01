import { supabase } from '../supabase'
import type { AnalyzeCandidateResponse } from '../ai/types'

export interface Candidate {
  id: string
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
}

export interface UpsertCandidateInput {
  analyzed: AnalyzeCandidateResponse
  rawText: string
  createdBy: string
  duplicateSuspected?: boolean
}

/**
 * 人材を登録または更新する
 * - email が同じ既存レコードがあれば UPDATE（上書き）
 * - email がない場合は常に INSERT
 * - AI が重複疑いと判断した場合は duplicate_flag=true をセット
 */
export async function upsertCandidate(input: UpsertCandidateInput): Promise<Candidate> {
  const { analyzed, rawText, createdBy, duplicateSuspected = false } = input

  const payload = {
    name: analyzed.name,
    email: analyzed.email,
    phone: analyzed.phone,
    skills: analyzed.skills,
    experience_years: analyzed.experienceYears,
    raw_profile: { text: rawText, summary: analyzed.summary },
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

/** 全候補者を取得（マージ済みを除外） */
export async function fetchCandidates(): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .is('merged_into', null)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

export interface UpdateCandidateInput {
  id: string
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
  const { id, ...rest } = input
  const { data, error } = await supabase
    .from('candidates')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(`候補者の更新に失敗しました: ${error.message}`)
  return data as Candidate
}

/** 候補者を削除する */
export async function deleteCandidate(id: string): Promise<void> {
  const { error } = await supabase
    .from('candidates')
    .delete()
    .eq('id', id)

  if (error) throw new Error(`候補者の削除に失敗しました: ${error.message}`)
}

/** duplicate_flag=true の候補者のみ取得 */
export async function fetchDuplicateCandidates(): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('duplicate_flag', true)
    .is('merged_into', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`重複候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}
