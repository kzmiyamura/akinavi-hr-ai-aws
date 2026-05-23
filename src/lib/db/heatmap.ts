import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

export interface PrefectureCount {
  prefecture: string
  count: number
}

/** 都道府県別の人材数を取得。skillFilter 指定時はスキルで絞り込む（DB側でJOIN・集計） */
export async function fetchPrefectureCounts(
  dataEnv: DataEnv,
  skillFilter: string | null
): Promise<PrefectureCount[]> {
  const { data, error } = await supabase.rpc('prefecture_counts', {
    p_data_env: dataEnv,
    p_skill: skillFilter ?? null,
  })
  if (error) throw error
  return (data ?? []).map((r: { prefecture: string; cnt: number }) => ({
    prefecture: r.prefecture,
    count: r.cnt,
  }))
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
