/** 人材マップ（県を選んだときの一覧）の並び替え。
 *
 *  2026-10-20 営業の要望「人材マップの表示されてる人材の並び替えも簡単にできると嬉しいな」。
 *  直前に「ボタンだけで絞りが効くように」と言われているので、ここもボタンで押せる形にする。
 *
 *  ⚠ **並べるのはこのファイルではなく DB（`candidates_by_prefecture` の ORDER BY）。**
 *     あの RPC は新しい順の先頭10件しか返さないので、受け取った10件を画面で並べ替えると
 *     「古い順」が *新着10件を古い順に並べたもの* になる＝その県で一番古い人は出ない。
 *     並びを変えると母集団が変わるため、キーは DB に渡すだけにしてある。
 *     （会社管理の `agentCompanySort.ts` は全件持っているので、あちらは画面側で並べている）
 *
 *  このファイルの役目は「キーの集合」と「画面に出す言葉」を1か所に置くこと。
 *  SQL 側の CASE と食い違っていないかは `__tests__/heatmapCandidateSort.test.ts` で突き合わせる。
 */

/** ⚠ 「星つきを先に」は入れていない。本番実測（2026-10-20）でブックマークが付いている
 *  人材は 1,822人中 0人。押しても並びが変わらないボタンは「効いていない」と思われるだけ。
 *  星が使われ始めたら、ここと SQL の ORDER BY に1行ずつ足す */
export type HeatmapSortKey = 'new' | 'old' | 'rate_low' | 'rate_high'

export const HEATMAP_SORT_DEFAULT: HeatmapSortKey = 'new'

export const HEATMAP_SORT_OPTIONS: { value: HeatmapSortKey; label: string }[] = [
  { value: 'new', label: '新しい順' },
  { value: 'old', label: '古い順' },
  { value: 'rate_low', label: '単価が安い順' },
  { value: 'rate_high', label: '単価が高い順' },
]

export function sortLabel(key: HeatmapSortKey): string {
  return HEATMAP_SORT_OPTIONS.find((o) => o.value === key)?.label ?? sortLabel(HEATMAP_SORT_DEFAULT)
}

export function isRateSort(key: HeatmapSortKey): boolean {
  return key === 'rate_low' || key === 'rate_high'
}

/**
 * 一覧の見出しに出す説明。**件数の上限と今の並びを必ず書く**。
 * 上限10件のまま並びだけ変わると、同じ県なのに出てくる人が入れ替わるので、
 * 「全員ではない」ことが読めないと取りこぼしに見える。
 *
 * 単価順のときは未取得の行き先も書く（ローカル控え実測で 5.6% は単価が読めない）。
 * 全期間ではアーカイブ済みが単価の列を持たないので、そちらを明示する。
 */
export function listCaption(key: HeatmapSortKey, limit: number, period: '7d' | 'all'): string {
  const head = `受信メール一覧（最大${limit}件・${sortLabel(key)}`
  if (!isRateSort(key)) return `${head}）`
  return `${head}・${period === 'all' ? 'アーカイブ済みと単価未取得は後ろ' : '単価未取得は後ろ'}）`
}

/**
 * 行に添える補助表示。**並び替えの基準になっている値そのもの**を出す。
 * 単価で並べたのに単価が見えないと、並んでいるか確かめようがない（上位候補の印で
 * 「必須9件中6件」を出したのと同じ理由・2026-10-20）。
 * 受信日時は元から行に出ているので、日時の並びでは何も足さない。
 */
export function sortMetaLabel(
  c: { desired_rate: string | null; is_archived: boolean },
  key: HeatmapSortKey,
): string | null {
  if (!isRateSort(key)) return null
  if (c.desired_rate) return c.desired_rate
  return c.is_archived ? '単価なし（アーカイブ）' : '単価未取得'
}
