import { supabase } from '../supabase'

export interface EmailSettings {
  email_human_address: string
  email_project_address: string
  email_use_ai_classification: boolean
  email_poll_mode: 'incremental' | 'full'
  email_full_import_since: string
}

const SETTING_KEYS: (keyof EmailSettings)[] = [
  'email_human_address',
  'email_project_address',
  'email_use_ai_classification',
  'email_poll_mode',
  'email_full_import_since',
]

const DEFAULTS: EmailSettings = {
  email_human_address: '',
  email_project_address: '',
  email_use_ai_classification: false,
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
    email_use_ai_classification:
      (map['email_use_ai_classification'] ?? 'false') === 'true',
    email_poll_mode:
      map['email_poll_mode'] === 'full' ? 'full' : 'incremental',
    email_full_import_since: map['email_full_import_since'] ?? DEFAULTS.email_full_import_since,
  }
}

/** メールアドレス設定・AI種別判断フラグを保存する */
export async function saveEmailAddressSettings(
  settings: Pick<
    EmailSettings,
    'email_human_address' | 'email_project_address' | 'email_use_ai_classification'
  >,
): Promise<void> {
  const rows = [
    { key: 'email_human_address', value: settings.email_human_address },
    { key: 'email_project_address', value: settings.email_project_address },
    {
      key: 'email_use_ai_classification',
      value: settings.email_use_ai_classification ? 'true' : 'false',
    },
  ]

  const { error } = await supabase
    .from('app_config')
    .upsert(rows, { onConflict: 'key' })

  if (error) throw new Error(`メール設定の保存に失敗しました: ${error.message}`)
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
