/**
 * 「提案済にする」「見送りにする」の押したときの遷移（#191・2026-10-20）。
 *
 * prod 実測（2026-10-19）で submissions は **117件すべて pending** だった。
 * 状態を進める画面が `src/pages/HistoryPage.tsx` にしか無く、そのページは
 * どこからも import されていなかった（ナビは5タブで提案履歴タブが無い）＝到達不能。
 * つまり「この人もう出したっけ」をアプリで答える手段が無かった。
 * HistoryPage は 2026-10-20 に削除した（印をこちらに移したので、残すと二重管理になる）。
 *
 * 直し方は3案あったが **B（判断する場所に印を足す）** を採った:
 *   A 提案履歴タブを戻す … スマホで6タブ目は重く、誰も開かなかったページを戻すだけ
 *   B マッチング結果の行に［提案済］［見送り］を足す ← これ
 *   C 提案済・見送りをやめる … 人材一覧の印（決定/提案済/見送り）の半分が死ぬ
 * 営業が「出した」と判断するのはマッチング結果を見ている瞬間なので、そこに置く。
 *
 * ⚠ pending は人の意思ではない。マッチングを実行すると候補全員に自動で作られる
 *    （upsertSubmissions）。だから「取り消し」は pending に戻すことで表す。
 */
import type { Submission } from './db/submissions'

export type MarkKind = 'sent' | 'rejected'

export const MARK_LABEL: Record<MarkKind, string> = {
  sent: '提案済',
  rejected: '見送り',
}

/**
 * 押したあとの状態。null = 押させない（参画確定の行は印で動かさない）。
 * 同じ印をもう一度押したら pending に戻す（押し間違いを自分で直せるように）。
 */
export function nextStatusFor(
  current: Submission['status'],
  kind: MarkKind,
): Submission['status'] | null {
  if (current === 'accepted') return null
  return current === kind ? 'pending' : kind
}

/** ボタンの見た目と説明。`active` はその印が付いている状態 */
export function markButton(
  current: Submission['status'],
  kind: MarkKind,
): { label: string; active: boolean; title: string; disabled: boolean } {
  const active = current === kind
  const disabled = nextStatusFor(current, kind) === null
  const label = active ? `${MARK_LABEL[kind]} ✓` : `${MARK_LABEL[kind]}にする`
  const title = disabled
    ? '参画確定した提案は印で動かせません（決定を取り消してから変えてください）'
    : active
      ? `${MARK_LABEL[kind]}の印を取り消す`
      : kind === 'sent'
        ? 'この案件に提案したことを記録する（人材一覧に「提案済」と出ます）'
        : 'この案件では見送ったことを記録する（人材一覧に「見送り」と出ます）'
  return { label, active, title, disabled }
}
