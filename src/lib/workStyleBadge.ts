/**
 * ワークスタイル印（workStyleTag: リモート希望 / 併用可 / 常駐可）の色。
 *
 * 人材タブのカード（CandidatePage）と人材マップの一覧の2か所で描くので、
 * 色の対応をここ1か所に置く（商流の `commercialFlowClass` と同じ扱い）。
 *   常駐可      … 緑（常駐案件に出せる）
 *   リモート希望 … 赤系（常駐案件には出しにくい）
 *   併用可・他  … 黄（条件つき）
 */
export function workStyleClass(tag: string): string {
  if (tag === '常駐可') return 'bg-emerald-100 text-emerald-800'
  if (tag === 'リモート希望') return 'bg-rose-100 text-rose-700'
  return 'bg-amber-100 text-amber-800'
}
