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
  // AI校正の状態。一覧では通信量削減のため raw_profile 全体を取らないので
  // JSON パス指定でこの2キーだけを別途取得する（fetchCandidatesPage 参照）
  llm_checked_at?: string | null
  llm_stage?: string | null
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

export interface ScoringWeights {
  skill: number
  exp: number
  rate: number
  location: number
  remote: number
  [key: string]: number
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  skill: 40,
  exp: 15,
  rate: 15,
  location: 20,
  remote: 10,
}

/** 案件内容からスコアウェイトを自動計算する（合計100pt） */
export function calcProjectWeights(project: {
  title?: string | null
  description?: string | null
  role_summary?: string | null
  required_skills?: unknown
  remote_policy?: string | null
}): ScoringWeights {
  const req = (project.required_skills as string[] | null) ?? []
  const fullText = [project.title, project.description, project.role_summary].filter(Boolean).join(' ')

  // ── スキルウェイト ──
  let skill = 40
  const hasLanguageSkill = req.some(s => /英語|中国語|韓国語|語学|通訳|翻訳|TOEIC|英検/.test(s))
  if (hasLanguageSkill) skill += 15        // 語学スキル必須 → スキル重視
  else if (req.length >= 5) skill += 10    // 必須スキル5件以上
  else if (req.length <= 2) skill -= 5     // 必須スキルが少ない

  // ── 経験年数ウェイト ──
  let exp = 15
  if (/経験年数不問|未経験可|第二新卒|経験問わ/.test(fullText)) exp = 5
  else if (/\d+年以上|\d+年超|ベテラン|シニア/.test(fullText)) exp = 20

  // ── リモートウェイト ──
  let remote = 10
  const isFullRemote = /フルリモート|完全リモート|100[%％]リモート/.test(project.remote_policy ?? '')
  const hasRemote = /リモート|在宅/.test(project.remote_policy ?? '')
  if (isFullRemote) remote = 20
  else if (!hasRemote) remote = 5

  // ── 勤務地ウェイト ──
  let location = 20
  if (isFullRemote) location = 10

  // ── 単価ウェイト（残り調整） ──
  const rate = Math.max(5, 100 - skill - exp - location - remote)

  return { skill, exp, rate, location, remote }
}

export interface ProjectScoreParams {
  requiredSkills?: string[]
  budgetMin?: number | null
  budgetMax?: number | null
  workLocation?: string | null
  remotePolicy?: string | null
  weights?: ScoringWeights
}

/**
 * 案件パラメータを SQL に渡してルールスコア順・登録日時順で候補者を取得。
 * SQL 内でスコア計算・ソートまで完結するため JS 側の再ソートは不要。
 */
export async function fetchCandidatesForProject(
  params: ProjectScoreParams,
  dataEnv: DataEnv,
  limit = 500,
  requireHaken = false,
): Promise<Candidate[]> {
  const w = params.weights ?? DEFAULT_SCORING_WEIGHTS
  const { data, error } = await supabase
    .rpc('fetch_candidates_for_project', {
      p_data_env:        dataEnv,
      p_required_skills: params.requiredSkills ?? [],
      p_budget_min:      params.budgetMin ?? null,
      p_budget_max:      params.budgetMax ?? null,
      p_work_location:   params.workLocation ?? null,
      p_remote_policy:   params.remotePolicy ?? null,
      p_limit:           limit,
      p_weight_skill:    w.skill,
      p_weight_exp:      w.exp,
      p_weight_rate:     w.rate,
      p_weight_location: w.location,
      p_weight_remote:   w.remote,
      p_require_haken:   requireHaken,
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
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  // emailReceivedAt（raw_profile内）がある場合はそれを優先して降順ソート
  const rows = (data ?? []) as Candidate[]
  return rows.sort((a, b) => {
    const aDate = (a.raw_profile as Record<string, unknown>)?.emailReceivedAt as string | null ?? a.created_at ?? ''
    const bDate = (b.raw_profile as Record<string, unknown>)?.emailReceivedAt as string | null ?? b.created_at ?? ''
    return bDate.localeCompare(aDate)
  })
}

/** 人材を100件ずつページ取得
 *  raw_profile は除外（TOAST 読み取り回避で 250ms → 38ms）。
 *  offset=0 のときのみ count=exact を付けてトータル件数を同一リクエストで返す。
 *  一覧カードはスキル数表示に top-level skills 列を使う。
 *  詳細表示時は fetchCandidateRawProfile RPC で別途取得。
 */
export async function fetchCandidatesPage(
  dataEnv: DataEnv,
  offset: number,
  limit = 100,
  prioritySkills?: string[] | null,
): Promise<{ candidates: Candidate[]; totalCount: number | null }> {
  const selectOpts = offset === 0 ? ({ count: 'exact' } as const) : {}
  let q = supabase
    .from('candidates')
    .select(
      // AI校正の状態は raw_profile 内にあるが、一覧では通信量削減のため raw_profile 全体を
      // 取得していない。必要な2キーだけを JSON パス指定で取り出す（2026-08-10）
      'id, name, email, phone, skills, experience_years, desired_rate, from_company, resume_url, drive_url, box_url, box_status, created_at, updated_at, duplicate_flag, merged_into, data_env, created_by, ' +
      'llm_checked_at:raw_profile->>_llm_checked_at, llm_stage:raw_profile->>_llm_stage',
      selectOpts,
    )
    .eq('data_env', dataEnv)
    .is('merged_into', null)

  // 優先スキル指定時は該当者だけを取得する。1,881件を19ページ抱えると
  // 一覧の再取得（invalidate）のたびに全ページを取り直して 2.5MB 飛ぶため、
  // 既定の読み込み量を減らす目的も兼ねる（2026-08-10 PostgREST egress 対策）。
  // 判定はワーカー側 buildSkillFilterClause と同じ二本立て（skills列 or 本文の部分一致）
  if (prioritySkills?.length) {
    q = q.or(prioritySkills.flatMap((s) => [
      `skills.cs.${JSON.stringify([s])}`,
      `raw_profile->>text.ilike.*${s}*`,
    ]).join(','))
  }

  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`候補者の取得に失敗しました: ${error.message}`)
  return { candidates: (data ?? []) as Candidate[], totalCount: offset === 0 ? (count ?? null) : null }
}

/** 優先表示するスキル（app_config.llm_filter_skills）。
 *  常駐AIの解析対象を絞る設定と同じものを共有し、「優先解析している人材が上に出る」を実現する。
 *  未設定・空配列なら null（＝絞り込みなし・従来どおり全件） */
export async function fetchPrioritySkills(): Promise<string[] | null> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'llm_filter_skills')
    .maybeSingle()
  let v: unknown = data?.value
  // value は jsonb だが '"true"' のように文字列で二重に入っている実例があるため2回まで解く
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v as string) } catch { break }
  }
  if (!Array.isArray(v)) return null
  const list = v.map((s) => String(s ?? '').trim()).filter(Boolean)
  return list.length ? list : null
}

/** 優先スキルを保存する。空配列（＝絞り込み解除）も明示的に保存できる。
 *  egress 逼迫時や Claude の利用制限に当たったときだけ絞る「非常用レバー」なので、
 *  平時は空のまま運用する想定 */
export async function savePrioritySkills(skills: string[]): Promise<void> {
  const clean = skills.map((s) => s.trim()).filter(Boolean)
  const { error } = await supabase
    .from('app_config')
    .upsert([{ key: 'llm_filter_skills', value: clean }], { onConflict: 'key' })
  if (error) throw new Error(`優先スキルの保存に失敗しました: ${error.message}`)
}

/** 詳細表示用: 特定候補の raw_profile 全体（text・parsedGrid を含む）を取得 */
export async function fetchCandidateRawProfile(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.rpc('fetch_candidate_raw_profile', { p_id: id })
  if (error) return null
  return data as Record<string, unknown> | null
}

/** 人材の総数を取得（検索ページでの件数表示など fetchCandidatesPage 以外の用途向け） */
export async function fetchCandidateCount(dataEnv: DataEnv): Promise<number> {
  const { count, error } = await supabase
    .from('candidates')
    .select('id', { count: 'exact', head: true })
    .eq('data_env', dataEnv)
    .is('merged_into', null)

  if (error) throw new Error(`候補者数の取得に失敗しました: ${error.message}`)
  return count ?? 0
}

export type SearchField = 'name' | 'skills' | 'prefecture' | 'body'
export const DEFAULT_SEARCH_FIELDS: SearchField[] = ['name', 'skills', 'prefecture']

/** キーワードでサーバーサイド検索（全件対象） */
export async function searchCandidates(
  dataEnv: DataEnv,
  keywords: string[],
  mode: 'AND' | 'OR',
  offset: number,
  limit = 100,
  fields: SearchField[] = DEFAULT_SEARCH_FIELDS,
): Promise<Candidate[]> {
  const { data, error } = await supabase.rpc('search_candidates', {
    p_data_env: dataEnv,
    p_keywords: keywords,
    p_mode: mode,
    p_limit: limit,
    p_offset: offset,
    p_fields: fields,
  })
  if (error) throw new Error(`人材の検索に失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

/** キーワード検索の件数を取得 */
export async function searchCandidateCount(
  dataEnv: DataEnv,
  keywords: string[],
  mode: 'AND' | 'OR',
  fields: SearchField[] = DEFAULT_SEARCH_FIELDS,
): Promise<number> {
  const { data, error } = await supabase.rpc('count_search_candidates', {
    p_data_env: dataEnv,
    p_keywords: keywords,
    p_mode: mode,
    p_fields: fields,
  })
  if (error) throw new Error(`候補者数の取得に失敗しました: ${error.message}`)
  return (data as number) ?? 0
}

export interface SkillYearFilter {
  skill: string
  minYears: number
}

export interface CandidateFilter {
  name?: string
  skills?: string[]
  skillYearFilters?: SkillYearFilter[]
  prefecture?: string
  expMin?: number
}

/** RPC に渡すスキル一覧（通常スキル + 年数付きスキルのスキル名） */
function rpcSkills(filter: CandidateFilter): string[] | null {
  const base = filter.skills ?? []
  const fromYear = (filter.skillYearFilters ?? []).map(f => f.skill)
  const merged = [...new Set([...base, ...fromYear])]
  return merged.length > 0 ? merged : null
}

/** 個別フィールドでフィルタリング（filter_candidates RPC） */
export async function filterCandidates(
  dataEnv: DataEnv,
  filter: CandidateFilter,
  offset: number,
  limit = 100,
): Promise<Candidate[]> {
  const { data, error } = await supabase.rpc('filter_candidates', {
    p_data_env:   dataEnv,
    p_name:       filter.name       ?? null,
    p_skills:     rpcSkills(filter),
    p_prefecture: filter.prefecture ?? null,
    p_exp_min:    filter.expMin     ?? null,
    p_limit:      limit,
    p_offset:     offset,
  })
  if (error) throw new Error(`人材のフィルタリングに失敗しました: ${error.message}`)
  return (data ?? []) as Candidate[]
}

/** フィルタリング件数取得 */
export async function filterCandidateCount(
  dataEnv: DataEnv,
  filter: CandidateFilter,
): Promise<number> {
  const { data, error } = await supabase.rpc('count_filter_candidates', {
    p_data_env:   dataEnv,
    p_name:       filter.name       ?? null,
    p_skills:     rpcSkills(filter),
    p_prefecture: filter.prefecture ?? null,
    p_exp_min:    filter.expMin     ?? null,
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
