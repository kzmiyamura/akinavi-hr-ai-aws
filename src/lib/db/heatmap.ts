import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

export interface PrefectureCount {
  prefecture: string
  count: number
}

/** 都道府県別の人材数を取得。skillFilter 指定時は candidate_skills と INNER JOIN で絞り込む */
export async function fetchPrefectureCounts(
  dataEnv: DataEnv,
  skillFilter: string | null
): Promise<PrefectureCount[]> {
  let rows: { raw_profile: unknown }[] = []

  if (skillFilter) {
    // candidate_skills → candidates を INNER JOIN して一発取得
    // （candidate_id の配列を .in() に渡すと URL が長すぎて失敗するため）
    const { data, error } = await supabase
      .from('candidates')
      .select('raw_profile, candidate_skills!inner(skill)')
      .eq('data_env', dataEnv)
      .ilike('candidate_skills.skill', `%${skillFilter}%`)
    if (error) throw error
    rows = data ?? []
  } else {
    const { data, error } = await supabase
      .from('candidates')
      .select('raw_profile')
      .eq('data_env', dataEnv)
    if (error) throw error
    rows = data ?? []
  }

  const counts: Record<string, number> = {}
  for (const row of rows) {
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
