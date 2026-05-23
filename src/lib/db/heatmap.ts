import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

export interface PrefectureCount {
  prefecture: string
  count: number
}

/** 都道府県別の人材数を取得。skillFilter 指定時は候補者をスキルで絞り込む */
export async function fetchPrefectureCounts(
  dataEnv: DataEnv,
  skillFilter: string | null
): Promise<PrefectureCount[]> {
  let candidateIds: string[] | null = null

  if (skillFilter) {
    // スキルに一致する candidate_id を取得
    const { data, error } = await supabase
      .from('candidate_skills')
      .select('candidate_id')
      .ilike('skill', `%${skillFilter}%`)
    if (error) throw error
    candidateIds = (data ?? []).map((r) => r.candidate_id as string)
    if (candidateIds.length === 0) return []
  }

  // candidates から都道府県を取得
  let query = supabase
    .from('candidates')
    .select('id, raw_profile')
    .eq('data_env', dataEnv)

  if (candidateIds) {
    query = query.in('id', candidateIds)
  }

  const { data, error } = await query
  if (error) throw error

  const counts: Record<string, number> = {}
  for (const row of data ?? []) {
    const pref = (row.raw_profile as Record<string, unknown>)?.prefecture as string | undefined
    if (!pref || pref === '不明') continue
    counts[pref] = (counts[pref] ?? 0) + 1
  }

  return Object.entries(counts)
    .map(([prefecture, count]) => ({ prefecture, count }))
    .sort((a, b) => b.count - a.count)
}

/** skill_master からスキル名一覧を取得（フィルター用ドロップダウン） */
export async function fetchSkillNames(): Promise<string[]> {
  const { data, error } = await supabase
    .from('skill_master')
    .select('name')
    .order('match_count', { ascending: false })
    .limit(200)
  if (error) throw error
  return (data ?? []).map((r) => r.name as string)
}
