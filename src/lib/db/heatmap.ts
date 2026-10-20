import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'
import { HEATMAP_SORT_DEFAULT, type HeatmapSortKey } from '../heatmapCandidateSort'
import { HEATMAP_FILTER_EMPTY, toRpcParams, type HeatmapFilterState } from '../heatmapFilters'

export interface PrefectureCount {
  prefecture: string
  count: number
}

/**
 * 都道府県別の人材数を取得。skillFilter 指定時はスキルで絞り込む（DB側でJOIN・集計）。
 *
 * ⚠ 絞り込み（所属・稼働・経歴書）は**地図の色とランキングにも効かせる**。
 *    一覧だけに効かせると「大阪に50人」と塗られている県を開いて3人しか出ず、
 *    どちらが本当か画面から判断できない。
 */
export async function fetchPrefectureCounts(
  dataEnv: DataEnv,
  skillFilter: string | null,
  period: '7d' | 'all' = '7d',
  filter: HeatmapFilterState = HEATMAP_FILTER_EMPTY
): Promise<PrefectureCount[]> {
  const f = toRpcParams(filter)
  const { data, error } = await supabase.rpc('prefecture_counts', {
    p_data_env: dataEnv,
    p_skill: skillFilter ?? null,
    p_period: period,
    p_flows: f.flows,
    p_types: f.types,
    p_available_now: f.availableNow,
    p_has_resume: f.hasResume,
    p_work_styles: f.workStyles,
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
  is_archived: boolean
  /** ブックマーク（星）。アーカイブ済みは列を持たないので常に false */
  bookmarked: boolean
  /** 希望単価（自由記述のまま）。アーカイブ済みは列が無いので常に null */
  desired_rate: string | null
  /** 商流（`自社` / `N社先`）。丸めは SQL の flow_bucket()。アーカイブ済みは null */
  commercial_flow: string | null
  /** 雇用形態（正社員 / フリーランス 等）。アーカイブ済みは null */
  employment_type: string | null
  /** 稼働時期。**書かれていた文字のまま**（「即日」「11月〜」）。アーカイブ済みは null */
  available_from: string | null
  /** 経験年数。アーカイブ済みは列が無いので null */
  experience_years: number | null
  /** ワークスタイル（workStyleTag: リモート希望 / 併用可 / 常駐可）。未取得・アーカイブ済みは null */
  work_style: string | null
}

/**
 * 都道府県クリック時に最大10件の人材を取得（件名・受信日時・氏名・希望単価）。
 *
 * ⚠ `sort` は **DB に渡す**。返るのは先頭 `limit` 件なので、受け取ってから画面で
 *    並べ替えると「古い順」が *新着10件を古い順に並べたもの* になる（母集団が変わる）。
 *    キーの集合は `src/lib/heatmapCandidateSort.ts` が正。
 */
export async function fetchCandidatesByPrefecture(
  dataEnv: DataEnv,
  prefecture: string,
  skillFilter: string | null,
  period: '7d' | 'all' = '7d',
  limit = 10,
  sort: HeatmapSortKey = HEATMAP_SORT_DEFAULT,
  filter: HeatmapFilterState = HEATMAP_FILTER_EMPTY
): Promise<PrefectureCandidate[]> {
  const f = toRpcParams(filter)
  const { data, error } = await supabase.rpc('candidates_by_prefecture', {
    p_data_env: dataEnv,
    p_prefecture: prefecture,
    p_skill: skillFilter ?? null,
    p_limit: limit,
    p_period: period,
    p_sort: sort,
    p_flows: f.flows,
    p_types: f.types,
    p_available_now: f.availableNow,
    p_has_resume: f.hasResume,
    p_work_styles: f.workStyles,
  })
  if (error) throw error
  return (data ?? []).map((r: {
    id: string; name: string; subject: string | null; created_at: string
    is_archived: boolean; bookmarked?: boolean; desired_rate?: string | null
    commercial_flow?: string | null; employment_type?: string | null
    available_from?: string | null; experience_years?: number | null
    work_style?: string | null
  }) => ({
    id: r.id,
    name: r.name || '不明',
    subject: r.subject,
    created_at: r.created_at,
    is_archived: r.is_archived,
    bookmarked: r.bookmarked === true,
    desired_rate: r.desired_rate ?? null,
    commercial_flow: r.commercial_flow ?? null,
    employment_type: r.employment_type ?? null,
    available_from: r.available_from ?? null,
    experience_years: r.experience_years ?? null,
    work_style: r.work_style ?? null,
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
