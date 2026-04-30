import { supabase } from './supabase'

export async function checkConnection(): Promise<{ ok: boolean; tables: string[]; error?: string }> {
  try {
    // app_config テーブルが存在するか確認（schema.sql 実行済みかのチェック）
    const { data, error } = await supabase
      .from('app_config')
      .select('key')
      .limit(5)

    if (error) {
      return { ok: false, tables: [], error: error.message }
    }

    const tables = (data ?? []).map((row) => row.key as string)
    return { ok: true, tables }
  } catch (e) {
    return { ok: false, tables: [], error: String(e) }
  }
}
