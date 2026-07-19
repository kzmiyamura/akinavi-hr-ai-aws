import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

export interface NotificationRule {
  id: string
  label: string
  name_keyword: string
  skill_keywords: string[]
  station_keyword: string
  notify_email: string
  enabled: boolean
  data_env: DataEnv
  created_by: string
  created_at: string
  updated_at: string
}

export interface NotificationRuleInput {
  label: string
  name_keyword: string
  skill_keywords: string[]
  station_keyword: string
  notify_email: string
  enabled: boolean
}

export const notificationRulesQueryKey = (dataEnv: DataEnv) => ['notification_rules', dataEnv]

/** テーブル未作成（マイグレーション未適用）を UI で案内するための判定 */
export function isTableMissingError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /notification_rules/.test(msg) && /(does not exist|schema cache|42P01)/i.test(msg)
}

export async function listNotificationRules(dataEnv: DataEnv): Promise<NotificationRule[]> {
  const { data, error } = await supabase
    .from('notification_rules')
    .select('*')
    .eq('data_env', dataEnv)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`通知ルールの取得に失敗しました: ${error.message}`)
  return (data ?? []).map((row) => ({
    ...row,
    skill_keywords: Array.isArray(row.skill_keywords) ? row.skill_keywords : [],
  })) as NotificationRule[]
}

export async function createNotificationRule(
  input: NotificationRuleInput,
  dataEnv: DataEnv,
  createdBy: string,
): Promise<void> {
  const { error } = await supabase.from('notification_rules').insert({
    ...input,
    data_env: dataEnv,
    created_by: createdBy,
  })
  if (error) throw new Error(`通知ルールの作成に失敗しました: ${error.message}`)
}

export async function updateNotificationRule(id: string, input: Partial<NotificationRuleInput>): Promise<void> {
  const { error } = await supabase
    .from('notification_rules')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`通知ルールの更新に失敗しました: ${error.message}`)
}

export async function deleteNotificationRule(id: string): Promise<void> {
  const { error } = await supabase.from('notification_rules').delete().eq('id', id)
  if (error) throw new Error(`通知ルールの削除に失敗しました: ${error.message}`)
}

/** 送信状態（設定の app_config から。エラーがあれば画面に表示する） */
export async function getNotifyStatus(): Promise<{ lastChecked: string; lastError: string }> {
  const { data } = await supabase
    .from('app_config')
    .select('key, value')
    .in('key', ['notify_last_checked_at', 'notify_last_error'])
  const map: Record<string, string> = {}
  for (const row of data ?? []) map[row.key] = row.value
  return {
    lastChecked: map['notify_last_checked_at'] ?? '',
    lastError: map['notify_last_error'] ?? '',
  }
}
