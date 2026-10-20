/** 人材マップ（県を選んだときの一覧）の並び替え。
 *
 *  2026-10-20 営業の要望「人材マップの表示されてる人材の並び替えも簡単にできると嬉しいな」。
 *  直前に「ボタンだけで絞りが効くように」と言われているので、ここもボタンで押せる形にする。
 *  同日の追加要望「使いやすさを考えて。人材マップ使う想定で何が絞り込んでソート出来たら
 *  使いやすいか」に対し、**稼働が早い順** と **経験が長い順** を足した（下のコメント参照）。
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
 *  星が使われ始めたら、ここと SQL の ORDER BY に1行ずつ足す
 *
 *  `avail_soon` / `exp_high` は本番実測で並びとして成立することを確かめてから足した
 *  （2026-10-20・1,878人中 稼働時期が日付として読める 1,541人=82% / 経験年数あり 1,807人=96%）。 */
export type HeatmapSortKey = 'new' | 'old' | 'avail_soon' | 'rate_low' | 'rate_high' | 'exp_high'

export const HEATMAP_SORT_DEFAULT: HeatmapSortKey = 'new'

/** 並びは営業が使う順に置く。受信の新しさ → いつ出せるか → いくらか → 腕 */
export const HEATMAP_SORT_OPTIONS: { value: HeatmapSortKey; label: string; title: string }[] = [
  { value: 'new', label: '新しい順', title: '受信が新しい人から' },
  { value: 'old', label: '古い順', title: 'その県でいちばん古く届いた人から（滞留を見る）' },
  { value: 'avail_soon', label: '稼働が早い順', title: '稼働できる時期が早い人から（即日＝今日として扱う）' },
  { value: 'rate_low', label: '単価が安い順', title: '希望単価の安い人から（範囲は下限で判定）' },
  { value: 'rate_high', label: '単価が高い順', title: '希望単価の高い人から（範囲は下限で判定）' },
  { value: 'exp_high', label: '経験が長い順', title: '経験年数の長い人から' },
]

export function sortLabel(key: HeatmapSortKey): string {
  return HEATMAP_SORT_OPTIONS.find((o) => o.value === key)?.label ?? sortLabel(HEATMAP_SORT_DEFAULT)
}

export function isRateSort(key: HeatmapSortKey): boolean {
  return key === 'rate_low' || key === 'rate_high'
}

/** 日時以外を基準にする並び。**値が取れていない人の行き先を画面に書く必要がある** */
function unknownTailLabel(key: HeatmapSortKey): string | null {
  if (isRateSort(key)) return '単価未取得'
  if (key === 'avail_soon') return '稼働時期未取得'
  if (key === 'exp_high') return '経験年数未取得'
  return null
}

/**
 * 一覧の見出しに出す説明。**件数の上限と今の並びを必ず書く**。
 * 上限10件のまま並びだけ変わると、同じ県なのに出てくる人が入れ替わるので、
 * 「全員ではない」ことが読めないと取りこぼしに見える。
 *
 * 値が取れていない人を後ろに回す並び（単価・稼働時期・経験年数）では行き先も書く。
 * 全期間ではアーカイブ済みがそれらの列を持たないので、そちらを明示する。
 */
export function listCaption(key: HeatmapSortKey, limit: number, period: '7d' | 'all'): string {
  const head = `受信メール一覧（最大${limit}件・${sortLabel(key)}`
  const tail = unknownTailLabel(key)
  if (!tail) return `${head}）`
  return `${head}・${period === 'all' ? `アーカイブ済みと${tail}` : tail}は後ろ）`
}

/** 並び替えの基準に使う値（行に出す用）。アーカイブ済みは列そのものが無い */
export interface HeatmapSortMetaSource {
  desired_rate: string | null
  available_from: string | null
  experience_years: number | null
  is_archived: boolean
}

/** 今の並びの基準になる値がその人に入っているか（入っていない人は後ろに回っている）。
 *  画面はこれで色を分ける。値がある＝橙 / 無い＝灰 */
export function hasSortValue(c: HeatmapSortMetaSource, key: HeatmapSortKey): boolean {
  if (isRateSort(key)) return !!c.desired_rate
  if (key === 'avail_soon') return !!c.available_from
  if (key === 'exp_high') return c.experience_years != null
  return false
}

/**
 * 行に添える補助表示。**並び替えの基準になっている値そのもの**を出す。
 * 単価で並べたのに単価が見えないと、並んでいるか確かめようがない（上位候補の印で
 * 「必須9件中6件」を出したのと同じ理由・2026-10-20）。
 * 受信日時は元から行に出ているので、日時の並びでは何も足さない。
 *
 * ⚠ 稼働時期は**書かれていた文字のまま**出す（「即日」を 10/20 に化かすと元メールと
 *    突き合わせたときに食い違う）。並びの判定だけ DB 側で日付に直している。
 */
export function sortMetaLabel(c: HeatmapSortMetaSource, key: HeatmapSortKey): string | null {
  if (isRateSort(key)) return c.desired_rate ?? (c.is_archived ? '単価なし（アーカイブ）' : '単価未取得')
  if (key === 'avail_soon') {
    if (c.available_from) return `稼働 ${c.available_from}`
    return c.is_archived ? '稼働時期なし（アーカイブ）' : '稼働時期未取得'
  }
  if (key === 'exp_high') {
    if (c.experience_years != null) return `経験 ${c.experience_years}年`
    return c.is_archived ? '経験年数なし（アーカイブ）' : '経験年数未取得'
  }
  return null
}
