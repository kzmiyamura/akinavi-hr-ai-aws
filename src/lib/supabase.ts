import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase 環境変数が設定されていません（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
