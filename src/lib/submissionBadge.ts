import type { SubmissionBadge } from './db/submissions'

/**
 * 人材一覧の「提案」バッジの文言。**一覧カードと絞り込み一覧の2か所で描いているので、
 * ここ1か所に置く**（以前は両方に同じ三項演算子がコピーされていた）。
 *
 * 2026-10-19 の指摘「提案候補の意味がわからない。何に対して？また4って何？」:
 *
 * ① `pending` を「提案候補」と書いていたが、この行は**マッチングを実行すると
 *    候補に挙がった人全員にその場で作られる**（MatchingPage の upsertSubmissions）。
 *    人が誰かに提案したわけではない。「提案候補」は人が選んだように読めるので、
 *    起きたことだけを書く＝「マッチ済」にした。
 * ② どの案件に対してかが画面のどこにも無かった。案件名を出す。
 * ③ 「提案候補4」の 4 は**案件の数**（この人が4案件の候補に挙がっている）。
 *    裸の数字は順位にも人数にも読めるので、必ず単位を付ける。
 *
 * prod 実測（2026-10-19）: 117件・53人・12案件。**117件すべて pending**。
 * `sent`（提案済）に進める画面は HistoryPage にしか無く、その画面はどこからも
 * 開けない（Layout の5タブに無く import もされていない）。
 * `accepted` はマッチング画面の［参画確定］、`rejected` はその副作用でのみ付く。
 */
export const SUBMISSION_STATUS_LABEL: Record<SubmissionBadge['best'], string> = {
  accepted: '決定',
  sent: '提案済',
  rejected: '見送り',
  pending: 'マッチ済',
}

export function submissionBadgeStyle(sb: SubmissionBadge, bordered: boolean): string {
  if (sb.best === 'accepted') return bordered ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-emerald-100 text-emerald-700'
  if (sb.best === 'sent') return bordered ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-blue-100 text-blue-700'
  if (sb.best === 'rejected') return bordered ? 'bg-gray-100 text-gray-500 border-gray-200' : 'bg-gray-100 text-gray-500'
  return bordered ? 'bg-violet-50 text-violet-700 border-violet-200' : 'bg-violet-50 text-violet-700'
}

/** 幅のあるカード用。案件名まで出す */
export function submissionBadgeText(sb: SubmissionBadge): string {
  const label = SUBMISSION_STATUS_LABEL[sb.best]
  const top = sb.projects[0]
  if (!top) return sb.count > 1 ? `${label} ${sb.count}案件` : label
  return sb.count > 1 ? `${label}: ${top.title} 他${sb.count - 1}案件` : `${label}: ${top.title}`
}

/** 氏名の隣に置く狭い行用。案件名は入らないので件数だけ。**単位は省かない** */
export function submissionBadgeShortText(sb: SubmissionBadge): string {
  const label = SUBMISSION_STATUS_LABEL[sb.best]
  return sb.count > 1 ? `${label} ${sb.count}案件` : label
}

/** マウスで読める端末向けの補足。スマホでは出ないので、ここだけに情報を置かない */
export function submissionBadgeTitle(sb: SubmissionBadge): string {
  const head = `マッチングの結果が ${sb.count}案件ぶん残っています`
  const lines = sb.projects.map(
    (p) => `・${p.title}（${SUBMISSION_STATUS_LABEL[p.status]}）`,
  )
  return [head, ...lines].join('\n')
}
