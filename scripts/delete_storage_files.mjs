/**
 * Supabase Storage の attachments/resumes バケット内のファイルを全削除するスクリプト
 * 使い方: node scripts/delete_storage_files.mjs
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://argizomylbolpqxgmvim.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_ROLE_KEY) {
  console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const BUCKET = 'attachments'
const PREFIX = 'resumes'
const BATCH = 100

async function deleteAll() {
  let total = 0
  let offset = 0

  console.log(`[delete] ${BUCKET}/${PREFIX} のファイルを全削除します...`)

  while (true) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(PREFIX, { limit: BATCH, offset })

    if (error) { console.error('[list] エラー:', error.message); break }
    if (!data || data.length === 0) break

    const paths = data.map(f => `${PREFIX}/${f.name}`)
    const { error: delErr } = await supabase.storage.from(BUCKET).remove(paths)
    if (delErr) {
      console.error('[delete] エラー:', delErr.message)
    } else {
      total += paths.length
      console.log(`  削除済み: ${total} 件`)
    }

    if (data.length < BATCH) break
    offset += BATCH
  }

  console.log(`[delete] 完了: 合計 ${total} ファイルを削除しました`)
}

deleteAll().catch(console.error)
