import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

export interface PrefectureCount {
  prefecture: string
  count: number
}

/** 都道府県別の人材数を取得。skillFilter 指定時はスキルで絞り込む（DB側でJOIN・集計） */
export async function fetchPrefectureCounts(
  dataEnv: DataEnv,
  skillFilter: string | null,
  period: '7d' | 'all' = '7d'
): Promise<PrefectureCount[]> {
  const { data, error } = await supabase.rpc('prefecture_counts', {
    p_data_env: dataEnv,
    p_skill: skillFilter ?? null,
    p_period: period,
  })
  if (error) throw error
  return (data ?? []).map((r: { prefecture: string; cnt: number }) => ({
    prefecture: r.prefecture,
    count: r.cnt,
  }))
}

export interface PrefectureCandidate {
  id: string
  name: string
  subject: string | null
  created_at: string
}

/** 都道府県クリック時に最大10件の人材を取得（件名・受信日時・氏名） */
export async function fetchCandidatesByPrefecture(
  dataEnv: DataEnv,
  prefecture: string,
  skillFilter: string | null,
  limit = 10
): Promise<PrefectureCandidate[]> {
  const { data, error } = await supabase.rpc('candidates_by_prefecture', {
    p_data_env: dataEnv,
    p_prefecture: prefecture,
    p_skill: skillFilter ?? null,
    p_limit: limit,
  })
  if (error) throw error
  return (data ?? []).map((r: { id: string; name: string; subject: string | null; created_at: string }) => ({
    id: r.id,
    name: r.name || '不明',
    subject: r.subject,
    created_at: r.created_at,
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
