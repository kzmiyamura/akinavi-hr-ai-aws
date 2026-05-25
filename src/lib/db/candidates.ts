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
  if (analyzed.desiredRate != null) profile.desiredRate = analyzed.desiredRate
  if (analyzed.nationality != null) profile.nationality = analyzed.nationality
  if (analyzed.selfPR != null) profile.selfPR = analyzed.selfPR
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
    desired_rate: analyzed.desiredRate ?? null,
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

/**
 * マッチング用候補者取得（RPC経由）
 * 優先順位: 登録日時 DESC → 経験年数 DESC
 * limit デフォルト 2000（7日分の全候補者を取りこぼさないよう余裕を持たせる）
 */
export async function fetchCandidatesForMatching(dataEnv: DataEnv, limit = 2000): Promise<Candidate[]> {
  const { data, error } = await supabase
    .rpc('fetch_candidates_for_matching', { p_data_env: dataEnv, p_limit: limit })
  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

export interface ProjectScoreParams {
  requiredSkills?: string[]
  budgetMin?: number | null
  budgetMax?: number | null
  workLocation?: string | null
  remotePolicy?: string | null
}

/**
 * 案件パラメータを SQL に渡してルールスコア順・登録日時順で候補者を取得。
 * SQL 内でスコア計算・ソートまで完結するため JS 側の再ソートは不要。
 */
export async function fetchCandidatesForProject(
  params: ProjectScoreParams,
  dataEnv: DataEnv,
  limit = 2000,
): Promise<Candidate[]> {
  const { data, error } = await supabase
    .rpc('fetch_candidates_for_project', {
      p_data_env:        dataEnv,
      p_required_skills: params.requiredSkills ?? [],
      p_budget_min:      params.budgetMin ?? null,
      p_budget_max:      params.budgetMax ?? null,
      p_work_location:   params.workLocation ?? null,
      p_remote_policy:   params.remotePolicy ?? null,
      p_limit:           limit,
    })
  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as (Candidate & { rule_score: number })[]
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

/** 人材を100件ずつページ取得 */
export async function fetchCandidatesPage(dataEnv: DataEnv, offset: number, limit = 100): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('data_env', dataEnv)
    .is('merged_into', null)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

/** 人材の総数を取得 */
export async function fetchCandidateCount(dataEnv: DataEnv): Promise<number> {
  const { count, error } = await supabase
    .from('candidates')
    .select('*', { count: 'exact', head: true })
    .eq('data_env', dataEnv)
    .is('merged_into', null)

  if (error) throw new Error(`候補者数の取得に失敗しました: ${error.message}`)
  return count ?? 0
}

export type SearchScope = 'tags' | 'body' | 'all'

/** キーワードでサーバーサイド検索（全件対象） */
export async function searchCandidates(
  dataEnv: DataEnv,
  keywords: string[],
  mode: 'AND' | 'OR',
  offset: number,
  limit = 100,
  scope: SearchScope = 'all',
): Promise<Candidate[]> {
  const { data, error } = await supabase.rpc('search_candidates', {
    p_data_env: dataEnv,
    p_keywords: keywords,
    p_mode: mode,
    p_limit: limit,
    p_offset: offset,
    p_scope: scope,
  })
  if (error) throw new Error(`人材の検索に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

/** キーワード検索の件数を取得 */
export async function searchCandidateCount(
  dataEnv: DataEnv,
  keywords: string[],
  mode: 'AND' | 'OR',
  scope: SearchScope = 'all',
): Promise<number> {
  const { data, error } = await supabase.rpc('count_search_candidates', {
    p_data_env: dataEnv,
    p_keywords: keywords,
    p_mode: mode,
    p_scope: scope,
  })
  if (error) throw new Error(`候補者数の取得に失敗しました: ${error.message}`)
  return (data as number) ?? 0
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

/** 全候補者を削除する（data_env 単位） */
export async function deleteAllCandidates(dataEnv: DataEnv): Promise<number> {
  const { count, error } = await supabase
    .from('candidates')
    .delete({ count: 'exact' })
    .eq('data_env', dataEnv)

  if (error) throw new Error(`全候補者の削除に失敗しました: ${error.message}`)
  return count ?? 0
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

/** 同一人物候補の型（スコア付き） */
export interface DuplicateCandidate {
  id: string
  name: string
  email: string | null
  raw_profile: Record<string, unknown>
  skills: string[]
  experience_years: number | null
  desired_rate: string | null
  from_company: string | null
  duplicate_flag: boolean
  duplicateScore: number
}

/**
 * 同名の別人材候補を取得する（RPC経由）
 * 名前の表記ゆれ（ピリオド・スペース・中点等）を除去して一致するものを返す
 */
export async function findDuplicateCandidates(
  name: string,
  excludeId: string,
  dataEnv: DataEnv
): Promise<Array<Omit<DuplicateCandidate, 'duplicateScore'>>> {
  const { data, error } = await supabase.rpc('find_duplicate_candidates', {
    p_name: name,
    p_exclude_id: excludeId,
    p_data_env: dataEnv,
  })
  if (error) {
    console.warn('[findDuplicateCandidates]', error.message)
    return []
  }
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    email: (row.email as string | null) ?? null,
    raw_profile: (row.raw_profile as Record<string, unknown>) ?? {},
    skills: Array.isArray(row.skills) ? (row.skills as string[]) : [],
    experience_years: (row.experience_years as number | null) ?? null,
    desired_rate: (row.desired_rate as string | null) ?? null,
    from_company: (row.from_company as string | null) ?? null,
    duplicate_flag: Boolean(row.duplicate_flag),
  }))
}

/**
 * 本番（prod）人材をランダムにデモ環境へコピーする。
 * - 重複フラグ済みはスキップ
 * - email は新規ユニーク値に差し替え（prod と衝突しないよう）
 * - resume_url / box_url は削除（Storage パスが prod 専用のため）
 * - drive_url は保持（公開 Google Drive リンク）
 */
export async function copyProdCandidatesToDemo(
  count: number,
  nickname: string,
  mode: 'random' | 'recent' = 'random',
): Promise<number> {
  let pool: Array<Record<string, unknown>> | null = null

  if (mode === 'recent') {
    // 直近コピー: created_at降順で上位 count 件を取得
    const { data, error: fetchErr } = await supabase
      .from('candidates')
      .select('name,email,phone,skills,experience_years,raw_profile,desired_rate,from_company,drive_url')
      .eq('data_env', 'prod')
      .eq('duplicate_flag', false)
      .order('created_at', { ascending: false })
      .limit(count)

    if (fetchErr) throw new Error(fetchErr.message)
    if (!data || data.length === 0) throw new Error('本番環境に人材データがありません')
    pool = data
  } else {
    // ランダムコピー: まず全件数を確認
    const { count: total, error: countErr } = await supabase
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .eq('data_env', 'prod')
      .eq('duplicate_flag', false)

    if (countErr) throw new Error(countErr.message)
    if (!total || total === 0) throw new Error('本番環境に人材データがありません')

    // ランダムなオフセットで最大 min(total, count*4, 100) 件取得してシャッフルで N 件選ぶ
    const poolSize = Math.min(total, Math.max(count * 4, 20), 100)
    const maxOffset = Math.max(0, total - poolSize)
    const offset = Math.floor(Math.random() * (maxOffset + 1))

    const { data, error: fetchErr } = await supabase
      .from('candidates')
      .select('name,email,phone,skills,experience_years,raw_profile,desired_rate,from_company,drive_url')
      .eq('data_env', 'prod')
      .eq('duplicate_flag', false)
      .range(offset, offset + poolSize - 1)

    if (fetchErr) throw new Error(fetchErr.message)
    if (!data || data.length === 0) throw new Error('取得できませんでした')
    pool = data
  }

  // ランダムモードのみシャッフルして N 件選ぶ
  const shuffled = mode === 'recent'
    ? pool.slice(0, count)
    : [...pool].sort(() => Math.random() - 0.5).slice(0, count)

  const makeUniqueId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  const rows = shuffled.map((c) => ({
    data_env: 'demo' as const,
    name: c.name,
    email: `demo.prod+${makeUniqueId()}@demo.invalid`,
    phone: c.phone,
    skills: c.skills,
    experience_years: c.experience_years,
    raw_profile: c.raw_profile,
    desired_rate: c.desired_rate,
    from_company: c.from_company,
    drive_url: c.drive_url,
    duplicate_flag: false,
    created_by: nickname,
  }))

  const { error: insertErr } = await supabase.from('candidates').insert(rows)
  if (insertErr) throw new Error(insertErr.message)
  return rows.length
}
