/**
 * 「同一人材の可能性」バッジ（2026-08-20）
 *
 * 別の紹介会社から同じ人が来ているときに出す。**レコードは統合しない**
 * （ユーザー判断「別人材のまま、可能性として出す」）。
 * 同じ人でも会社によって単価が違うため（実測: 80万 と 85万）、
 * 統合すると営業が比較できなくなる。
 *
 * 判定は取り込み時（inbound-email）に行い、raw_profile.sameAsOtherAgency へ
 * 双方向に書いている。判定条件は「正規化した氏名が一致」＋「駅・都道府県が矛盾しない」
 * ＋「経験年数の差が5年未満」＋「スキル一致度（Jaccard）0.4以上」。
 */

/** raw_profile.sameAsOtherAgency の形 */
export interface SameAsOtherAgency {
  candidateId?: string
  company?: string | null
  mailFrom?: string | null
  desiredRate?: string | null
  subject?: string | null
  jaccard?: number
  at?: string
}

/** raw_profile から安全に取り出す（キーが無い・形が違う場合は null） */
export function readSameAsOtherAgency(rawProfile: unknown): SameAsOtherAgency | null {
  if (!rawProfile || typeof rawProfile !== 'object') return null
  const v = (rawProfile as Record<string, unknown>).sameAsOtherAgency
  if (!v || typeof v !== 'object') return null
  return v as SameAsOtherAgency
}

export function SameAsOtherAgencyBadge({
  info,
  onOpen,
}: {
  info: SameAsOtherAgency
  /** 相手の人材を開く（渡さなければ表示のみ） */
  onOpen?: (candidateId: string) => void
}) {
  const label = [info.company, info.desiredRate].filter(Boolean).join(' ／ ')
  const pct = typeof info.jaccard === 'number' ? `${Math.round(info.jaccard * 100)}%` : null
  const title = [
    '別の紹介会社から同じ人材が来ている可能性があります（レコードは分けたままです）',
    info.company ? `相手の会社: ${info.company}` : null,
    info.desiredRate ? `相手の提示単価: ${info.desiredRate}` : null,
    pct ? `スキル一致度: ${pct}` : null,
  ].filter(Boolean).join('\n')

  const content = (
    <>
      同一人材の可能性
      {label && <span className="ml-1 font-normal">（{label}）</span>}
      {pct && <span className="ml-1 text-amber-600">一致{pct}</span>}
    </>
  )
  const cls = 'inline-flex items-center gap-1 text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 rounded px-1.5 py-0.5'

  if (onOpen && info.candidateId) {
    return (
      <button type="button" title={title} onClick={() => onOpen(info.candidateId!)}
        className={`${cls} hover:bg-amber-100 transition-colors`}>
        {content}
      </button>
    )
  }
  return <span title={title} className={cls}>{content}</span>
}
