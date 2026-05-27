import { supabase } from '../supabase'

export interface MatchingSettings {
  fast_max_candidates_per_project: number
  fast_max_projects_per_candidate: number
  run_mode: 'fast' | 'full'
}

export const MATCHING_DEFAULTS: MatchingSettings = {
  fast_max_candidates_per_project: 20,
  fast_max_projects_per_candidate: 10,
  run_mode: 'fast',
}

const KEYS = ['matching_fast_max_candidates', 'matching_fast_max_projects', 'matching_run_mode']

export async function getMatchingSettings(): Promise<MatchingSettings> {
  const { data } = await supabase
    .from('app_config')
    .select('key, value')
    .in('key', KEYS)

  const map: Record<string, string> = {}
  for (const row of data ?? []) map[row.key] = row.value

  const parsePosInt = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  return {
    fast_max_candidates_per_project: parsePosInt(
      map['matching_fast_max_candidates'],
      MATCHING_DEFAULTS.fast_max_candidates_per_project,
    ),
    fast_max_projects_per_candidate: parsePosInt(
      map['matching_fast_max_projects'],
      MATCHING_DEFAULTS.fast_max_projects_per_candidate,
    ),
    run_mode: map['matching_run_mode'] === 'full' ? 'full' : 'fast',
  }
}

export async function saveMatchingSettings(settings: MatchingSettings): Promise<void> {
  const rows = [
    { key: 'matching_fast_max_candidates', value: String(settings.fast_max_candidates_per_project) },
    { key: 'matching_fast_max_projects', value: String(settings.fast_max_projects_per_candidate) },
    { key: 'matching_run_mode', value: settings.run_mode },
  ]
  const { error } = await supabase.from('app_config').upsert(rows, { onConflict: 'key' })
  if (error) throw new Error(`マッチング設定の保存に失敗しました: ${error.message}`)
}
