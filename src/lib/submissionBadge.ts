import type { SubmissionBadge } from './db/submissions'
import type { TopMatchMarkSet } from './db/topMatchMarks'

/**
 * 人材一覧に出す印の文言。**一覧カードと絞り込み一覧の2か所で描いているので、
 * ここ1か所に置く**（以前は両方に同じ三項演算子がコピーされていた）。
 *
 * ── 2026-10-19 の指摘と、それで変えたこと ───────────────────────────
 *
 * ①「提案候補の意味がわからない。何に対して？また4って何？」
 *   `pending` を「提案候補」と書いていたが、この行は**マッチングを実行すると
 *   候補に挙がった人全員にその場で作られる**（MatchingPage の upsertSubmissions）。
 *   人が誰かを選んだ記録ではない。4 は**案件の数**だった。
 *
 * ②「マッチングやり直したら上位に入るかもの印が出たらいいかも」
 *   `pending` は**過去に一度上位に入っただけ**で、今の順位とは関係なく残り続ける
 *   （実測で、上位20人しか保存しないはずの案件に31件・28件 溜まっていた）。
 *   人材は7日で消え毎日入れ替わるので、履歴はすぐ当てにならない。
 *   そこで `pending` の印は**出さない**ことにし、代わりに
 *   「今の上位5人」（top_match_marks・1時間ごとに再計算）を「上位候補」として出す。
 *
 * 残す印は **人が動かしたときだけ付くもの**＝決定・提案済・見送りだけ。
 * prod 実測（2026-10-19）では117件すべて pending で、この3つは1件も無かった
 * （提案済にする画面がどこからも開けない＝ issue #191）。
 */
export const SUBMISSION_STATUS_LABEL: Record<SubmissionBadge['best'], string> = {
  accepted: '決定',
  sent: '提案済',
  rejected: '見送り',
  // 画面には出さない（上の②）。詳細の履歴一覧にだけ使う
  pending: 'マッチ済',
}

/** 人が動かした記録か。pending はマッチング実行の副産物なので印にしない */
export function hasHumanSubmission(sb: SubmissionBadge | undefined | null): sb is SubmissionBadge {
  return !!sb && sb.best !== 'pending'
}

export type BadgeTone = 'accepted' | 'sent' | 'rejected' | 'topMatch'

export function badgeStyle(tone: BadgeTone, bordered: boolean): string {
  if (tone === 'accepted') return bordered ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-emerald-100 text-emerald-700'
  if (tone === 'sent') return bordered ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-blue-100 text-blue-700'
  if (tone === 'rejected') return bordered ? 'bg-gray-100 text-gray-500 border-gray-200' : 'bg-gray-100 text-gray-500'
  // 上位候補＝「今すぐ見て」なので目に留まる色にする
  return bordered ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-amber-100 text-amber-800'
}

export interface CandidateBadge {
  tone: BadgeTone
  /** 幅のあるカード用。案件名まで出す */
  text: string
  /** 氏名の隣の狭い行用。案件名は入らないので件数だけ */
  shortText: string
  /** マウスで読める端末向けの補足。スマホでは出ないので、ここだけに情報を置かない */
  title: string
}

/**
 * その人に出す印を1つ決める。人が動かした記録を優先し、無ければ今の上位候補。
 * 両方無ければ印なし。
 */
export function resolveCandidateBadge(
  sb: SubmissionBadge | undefined | null,
  tm: TopMatchMarkSet | undefined | null,
): CandidateBadge | null {
  if (hasHumanSubmission(sb)) {
    const tone = sb.best as BadgeTone
    const label = SUBMISSION_STATUS_LABEL[sb.best]
    const top = sb.projects.find((p) => p.status === sb.best) ?? sb.projects[0]
    const others = sb.count - 1
    return {
      tone,
      text: top
        ? (others > 0 ? `${label}: ${top.title} 他${others}案件` : `${label}: ${top.title}`)
        : (sb.count > 1 ? `${label} ${sb.count}案件` : label),
      shortText: sb.count > 1 ? `${label} ${sb.count}案件` : label,
      title: [
        `マッチングの結果が ${sb.count}案件ぶん残っています`,
        ...sb.projects.map((p) => `・${p.title}（${SUBMISSION_STATUS_LABEL[p.status]}）`),
      ].join('\n'),
    }
  }

  if (tm && tm.projects.length > 0) {
    // 並び順は呼び出し側に頼らない。一番いい順位の案件をここで選ぶ
    const byRank = [...tm.projects].sort((a, b) => a.rank - b.rank)
    const top = byRank[0]
    const others = tm.count - 1
    return {
      tone: 'topMatch',
      text: others > 0
        ? `上位候補: ${top.title}（${top.rank}位）他${others}案件`
        : `上位候補: ${top.title}（${top.rank}位）`,
      shortText: tm.count > 1 ? `上位候補 ${tm.count}案件` : `上位候補 ${top.rank}位`,
      title: [
        '今マッチングし直すと、この案件の上位に入ります（最大1時間前の計算）',
        ...byRank.map((p) => `・${p.rank}位 ${p.title}`),
      ].join('\n'),
    }
  }

  return null
}
