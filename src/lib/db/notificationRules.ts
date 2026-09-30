import { supabase } from '../supabase'
import type { DataEnv } from '../dataEnv'

/**
 * 2026-10-01 に足した絞り込み条件。
 * 判定の本体は `supabase/functions/notify-candidates/match.ts`（そちらが正）。
 * 追加前に prod 4,204人で埋まり具合を実測している（migration のコメント参照）。
 */
export interface NotificationRuleFilters {
  /** 年齢の範囲（null = 指定なし）。「20代後半〜40代」は 25〜49 */
  age_min: number | null
  age_max: number | null
  /** 経験年数の下限。実測で5年以上が88%なので**単独では絞りにならない** */
  experience_years_min: number | null
  /** skill_keywords のいずれかでこの年数以上あること */
  skill_years_min: number | null
  /** 到達レベルCの印しか無い人を外す（「教育が必要な人」に一番近い印） */
  exclude_level_c: boolean
  /** 経歴本文のキーワード（OR）。共通部品・共通基盤など */
  text_keywords: string[]
  /** 値が取れていない人材を通すか（既定 true） */
  include_unknown: boolean
}

export interface NotificationRule extends NotificationRuleFilters {
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

export interface NotificationRuleInput extends NotificationRuleFilters {
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
  // マイグレーション適用前の行は新しい列を持たない。画面が undefined を踏まないよう既定を入れる
  return (data ?? []).map((row) => ({
    ...row,
    skill_keywords: Array.isArray(row.skill_keywords) ? row.skill_keywords : [],
    text_keywords: Array.isArray(row.text_keywords) ? row.text_keywords : [],
    age_min: row.age_min ?? null,
    age_max: row.age_max ?? null,
    experience_years_min: row.experience_years_min ?? null,
    skill_years_min: row.skill_years_min ?? null,
    exclude_level_c: row.exclude_level_c ?? false,
    include_unknown: row.include_unknown ?? true,
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
