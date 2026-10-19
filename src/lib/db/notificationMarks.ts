import { supabase } from '../supabase'

/**
 * 「メール通知で送った」印（2026-10-20 営業の要望「後メール通知で送った印もあるといい」）。
 *
 * 元は `notification_log`（ルール×人材で一意・二重通知防止の記録）。
 * ただしこの表は service_role 専用で anon からは読めないので、
 * 宛先を落としたビュー `notification_marks` から読む（20261020_notification_marks_view.sql）。
 *
 * ⚠ 記録は人材より長生きする。人材は7日で消えるが notification_log は FK を張っておらず残る
 *   （「人材は消えるが通知履歴は残す」が元の設計意図）。本番実測（2026-10-20）で
 *   246件のうち**今いる人材に当たるのは16人**。印が少なく見えてもそれが実態。
 */
export interface NotificationMark {
  /** 最後に送った時刻（ISO） */
  sentAt: string
  /** 送った通知ルールの名前。同じ人が複数のルールで送られることがある */
  rules: string[]
}

export async function fetchNotificationMarks(
  candidateIds: string[],
): Promise<Map<string, NotificationMark>> {
  const out = new Map<string, NotificationMark>()
  if (candidateIds.length === 0) return out

  const { data, error } = await supabase
    .from('notification_marks')
    .select('candidate_id,rule_label,sent_at')
    .in('candidate_id', candidateIds)
  if (error) throw new Error(`通知済みの取得に失敗しました: ${error.message}`)

  for (const row of (data ?? []) as Array<{ candidate_id: string; rule_label: string | null; sent_at: string }>) {
    const prev = out.get(row.candidate_id)
    const label = (row.rule_label ?? '').trim() || '（削除されたルール）'
    if (!prev) {
      out.set(row.candidate_id, { sentAt: row.sent_at, rules: [label] })
      continue
    }
    // 複数ルールで送られていたら、新しい送信時刻を代表にする
    if (row.sent_at > prev.sentAt) prev.sentAt = row.sent_at
    if (!prev.rules.includes(label)) prev.rules.push(label)
  }
  return out
}
