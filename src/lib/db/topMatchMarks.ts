import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

/**
 * 「マッチングをやり直したら上位に入るかも」の印（2026-10-19 営業の要望）。
 *
 * 元になる `top_match_marks` は、公開中の案件それぞれの**今の上位N人**を記録した表。
 * 順位の付け方はマッチング画面とまったく同じ関数を呼んでいるので、
 * 印が付いた人は開いたときも本当に上位に並ぶ。
 *
 * 計算のきっかけは **人材が届いたとき**（2026-10-20 営業の指示
 * 「1時間でやり直しとかしなくてもいい。人材が届いた際の判断のみで」）。
 * cron `top-match-marks-on-arrival` が10分おきに「前回の計算より後に届いた人がいるか」
 * だけを見て、いなければ何もしない（`refresh_top_match_marks_if_new`）。
 *
 * ⚠ **最大10分遅れる。** 1周は本番実測で40秒かかる（open案件15件・充足数の計算を含む）ので、
 *   人材タブを開くたびには計算できない。届いたばかりの人に印が無いことはある。
 */
export interface TopMatchMark {
  projectId: string
  title: string
  /** その案件での順位（1が1位） */
  rank: number
  /**
   * 必須スキルのうち満たしている数 / 必須スキルの数。
   * 2026-10-20 に足した。営業から「本当か？データ分析基盤やで。bigqueryとかやろ？」と
   * 疑われたとき、**画面からは確かめようが無かった**ため（実際には合っていた）。
   * 古い行や、スキル指定の無い案件では null / 0 になる
   */
  skillHit: number | null
  skillTotal: number | null
}

export interface TopMatchMarkSet {
  /** 上位に入っている案件の数 */
  count: number
  /** 順位の良い順。先頭がバッジに出る1件 */
  projects: TopMatchMark[]
}

export async function fetchTopMatchMarks(
  candidateIds: string[],
  dataEnv: DataEnv,
): Promise<Map<string, TopMatchMarkSet>> {
  const out = new Map<string, TopMatchMarkSet>()
  if (candidateIds.length === 0) return out

  // 案件名は行に埋め込まない（同じ名前が行数ぶん繰り返される）。
  // 本番実測（2026-10-19）: 印75行のIDだけで 9.0KB、案件名15件は別に約1.5KB
  const { data, error } = await supabase
    .from('top_match_marks')
    .select('candidate_id,project_id,rank,skill_hit,skill_total')
    .eq('data_env', dataEnv)
    .in('candidate_id', candidateIds)
  if (error) throw new Error(`上位候補の取得に失敗しました: ${error.message}`)
  const rows = (data ?? []) as Array<{
    candidate_id: string; project_id: string; rank: number
    skill_hit: number | null; skill_total: number | null
  }>
  if (rows.length === 0) return out

  const titles = new Map<string, string>()
  const { data: projects } = await supabase
    .from('projects')
    .select('id,title')
    .in('id', [...new Set(rows.map((r) => r.project_id))])
  for (const p of (projects ?? []) as Array<{ id: string; title: string | null }>) {
    titles.set(p.id, (p.title ?? '').trim() || '（案件名なし）')
  }

  for (const row of rows) {
    const entry: TopMatchMark = {
      projectId: row.project_id,
      // 案件は ON DELETE CASCADE なので普通は消えない。取れなかったことは隠さない
      title: titles.get(row.project_id) ?? '（削除された案件）',
      rank: row.rank,
      skillHit: row.skill_hit,
      skillTotal: row.skill_total,
    }
    const cur = out.get(row.candidate_id)
    if (!cur) out.set(row.candidate_id, { count: 1, projects: [entry] })
    else {
      cur.count++
      cur.projects.push(entry)
    }
  }
  for (const set of out.values()) set.projects.sort((a, b) => a.rank - b.rank)
  return out
}

/** 印をいつ計算したか。「古い印かもしれない」を画面で言えるようにする */
export async function fetchTopMatchComputedAt(): Promise<string | null> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'top_match_marks_computed_at')
    .maybeSingle()
  const v = (data as { value?: unknown } | null)?.value
  return typeof v === 'string' ? v : null
}
