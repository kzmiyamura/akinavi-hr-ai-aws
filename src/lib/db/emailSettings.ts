import { supabase } from '../supabase'

export interface EmailSettings {
  email_human_address: string
  email_project_address: string
  email_human_dev_address: string
  email_project_dev_address: string
  email_use_ai_classification: boolean
  email_use_ai_classification_dev: boolean
  email_poll_mode: 'incremental' | 'full' | 'paused'
  email_full_import_since: string
}

const SETTING_KEYS = [
  'email_human_address',
  'email_project_address',
  'email_human_dev_address',
  'email_project_dev_address',
  'email_use_ai_classification',
  'email_use_ai_classification_dev',
  'email_poll_mode',
  'email_full_import_since',
]

const DEFAULTS: EmailSettings = {
  email_human_address: '',
  email_project_address: '',
  email_human_dev_address: '',
  email_project_dev_address: '',
  email_use_ai_classification: false,
  email_use_ai_classification_dev: false,
  email_poll_mode: 'incremental',
  email_full_import_since: '',
}

/** app_config からメール設定を全件読み込む */
export async function getEmailSettings(): Promise<EmailSettings> {
  const { data, error } = await supabase
    .from('app_config')
    .select('key, value')
    .in('key', SETTING_KEYS as string[])

  if (error) throw new Error(`メール設定の取得に失敗しました: ${error.message}`)

  const map: Record<string, string> = {}
  for (const row of data ?? []) {
    map[row.key] = row.value
  }

  return {
    email_human_address: map['email_human_address'] ?? DEFAULTS.email_human_address,
    email_project_address: map['email_project_address'] ?? DEFAULTS.email_project_address,
    email_human_dev_address: map['email_human_dev_address'] ?? DEFAULTS.email_human_dev_address,
    email_project_dev_address: map['email_project_dev_address'] ?? DEFAULTS.email_project_dev_address,
    email_use_ai_classification:
      (map['email_use_ai_classification'] ?? 'false') === 'true',
    email_use_ai_classification_dev:
      (map['email_use_ai_classification_dev'] ?? 'false') === 'true',
    email_poll_mode:
      map['email_poll_mode'] === 'full'
        ? 'full'
        : map['email_poll_mode'] === 'paused'
          ? 'paused'
          : 'incremental',
    email_full_import_since: map['email_full_import_since'] ?? DEFAULTS.email_full_import_since,
  }
}

/** メールアドレス設定・AI種別判断フラグを保存する */
export async function saveEmailAddressSettings(
  settings: Pick<
    EmailSettings,
    | 'email_human_address'
    | 'email_project_address'
    | 'email_human_dev_address'
    | 'email_project_dev_address'
    | 'email_use_ai_classification'
    | 'email_use_ai_classification_dev'
  >,
): Promise<void> {
  const rows = [
    { key: 'email_human_address', value: settings.email_human_address },
    { key: 'email_project_address', value: settings.email_project_address },
    { key: 'email_human_dev_address', value: settings.email_human_dev_address },
    { key: 'email_project_dev_address', value: settings.email_project_dev_address },
    { key: 'email_use_ai_classification', value: settings.email_use_ai_classification ? 'true' : 'false' },
    { key: 'email_use_ai_classification_dev', value: settings.email_use_ai_classification_dev ? 'true' : 'false' },
  ]

  const { error } = await supabase
    .from('app_config')
    .upsert(rows, { onConflict: 'key' })

  if (error) throw new Error(`メール設定の保存に失敗しました: ${error.message}`)
}

/** 案件メール解析の有効/無効を取得する（デフォルト: false） */
export async function getProjectInboundEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'inbound_project_enabled')
    .maybeSingle()
  return data?.value === 'true'
}

/** 案件メール解析の有効/無効を保存する */
export async function saveProjectInboundEnabled(enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'inbound_project_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' })
  if (error) throw new Error(`案件メール解析設定の保存に失敗しました: ${error.message}`)
}

/** 自動マッチングの有効/無効を取得する */
export async function getAutoMatchEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'auto_match_enabled')
    .maybeSingle()
  // 未設定の場合はデフォルト true
  return data?.value !== 'false'
}

/** 自動マッチングの有効/無効を保存する */
export async function saveAutoMatchEnabled(enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'auto_match_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' })
  if (error) throw new Error(`自動マッチング設定の保存に失敗しました: ${error.message}`)
}

/** Microsoft アカウントごとの接続状態を取得する */
export async function getConnectionStatuses(): Promise<Record<string, boolean>> {
  const accounts = ['human_prod', 'project_prod', 'human_dev', 'project_dev']
  const keys = accounts.map(a => `graph_connected_${a}`)
  const { data } = await supabase.from('app_config').select('key, value').in('key', keys)
  const result: Record<string, boolean> = {}
  for (const account of accounts) {
    const row = (data ?? []).find(r => r.key === `graph_connected_${account}`)
    result[account] = row?.value === true || row?.value === 'true' || row?.value === '"true"'
  }
  return result
}

/** 全件取り込みモードを開始する（poll_mode を 'full' にして since 日付を設定） */
export async function startFullImport(since: string): Promise<void> {
  const rows = [
    { key: 'email_poll_mode', value: 'full' },
    { key: 'email_full_import_since', value: since },
  ]

  const { error } = await supabase
    .from('app_config')
    .upsert(rows, { onConflict: 'key' })

  if (error) throw new Error(`全件取り込みの開始に失敗しました: ${error.message}`)
}

/** 全件取り込みを一時停止する（poll_mode を 'paused' にする） */
export async function pauseFullImport(): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'email_poll_mode', value: 'paused' }, { onConflict: 'key' })

  if (error) throw new Error(`一時停止に失敗しました: ${error.message}`)
}

/** 全件取り込みを再開する（poll_mode を 'full' に戻す） */
export async function resumeFullImport(): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'email_poll_mode', value: 'full' }, { onConflict: 'key' })

  if (error) throw new Error(`再開に失敗しました: ${error.message}`)
}

/** 全件取り込みの進捗を取得する（since以降のai_logs成功件数） */
export async function getImportProgress(since: string): Promise<number> {
  if (!since) return 0
  const { count, error } = await supabase
    .from('ai_logs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'success')
    .gte('created_at', `${since}T00:00:00Z`)

  if (error) return 0
  return count ?? 0
}

/** 人材データ保持日数を取得（デフォルト 7 日） */
export async function getCandidateRetentionDays(): Promise<number> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'candidate_retention_days')
    .maybeSingle()
  const v = parseInt(data?.value ?? '', 10)
  return isNaN(v) || v < 1 ? 7 : v
}

/** 人材データ保持日数を保存 */
export async function saveCandidateRetentionDays(days: number): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'candidate_retention_days', value: String(days) }, { onConflict: 'key' })
  if (error) throw new Error(`保持日数の保存に失敗しました: ${error.message}`)
}

/** アプリメモを取得 */
export async function getAppMemo(): Promise<string> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'app_memo')
    .maybeSingle()
  return data?.value ?? ''
}

/** アプリメモを保存 */
export async function saveAppMemo(memo: string): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'app_memo', value: memo }, { onConflict: 'key' })
  if (error) throw new Error(`メモの保存に失敗しました: ${error.message}`)
}

/** 全件取り込みまたは一時停止中か（UIの自動更新判定用） */
export async function getIsImportActive(): Promise<boolean> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'email_poll_mode')
    .maybeSingle()
  return data?.value === 'full' || data?.value === 'paused'
}
