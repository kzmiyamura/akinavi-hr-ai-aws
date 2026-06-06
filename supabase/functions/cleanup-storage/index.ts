/**
 * cleanup-storage Edge Function
 *
 * Supabase Storage に蓄積した古いファイル（7日以上前）を削除して無料枠を回復する。
 * pg_cron から毎日 JST 1:00 に呼び出される。
 *
 * 対象バケット: 'resumes'（PDFや経歴書）
 * 削除基準: created_at が retention_days（既定 7日）以上前のオブジェクト
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

function getEnv(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing env: ${key}`)
  return v
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

  // retention_days は app_config から取得（なければ 7 日）
  const { data: configRow } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'storage_retention_days')
    .single()
  const retentionDays = configRow?.value ? parseInt(configRow.value, 10) : 7

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffISO = cutoff.toISOString()

  // バケット名 → フォルダプレフィックスのマッピング
  // attachments バケットの resumes/ フォルダが対象（2026-05-23以降 Storage書き込みは廃止済み）
  const TARGETS: { bucket: string; folder: string }[] = [
    { bucket: 'attachments', folder: 'resumes' },
  ]
  const summary: Record<string, { deleted: number; errors: number; freedBytes: number }> = {}

  for (const { bucket, folder } of TARGETS) {
    let deleted = 0
    let errors = 0
    let freedBytes = 0
    let offset = 0
    const PAGE_SIZE = 100

    // deno-lint-ignore no-constant-condition
    while (true) {
      const { data: files, error: listError } = await supabase.storage
        .from(bucket)
        .list(folder, { limit: PAGE_SIZE, offset, sortBy: { column: 'created_at', order: 'asc' } })

      if (listError) {
        console.error(`[cleanup-storage] list error bucket=${bucket}/${folder} offset=${offset}:`, listError.message)
        break
      }
      if (!files || files.length === 0) break

      // cutoff より古いファイルだけ対象（created_at がない場合も削除対象にする）
      const oldFiles = files.filter(f => {
        const created = f.created_at ?? (f.metadata as Record<string, string> | null)?.lastModified
        return !created || created < cutoffISO
      })

      if (oldFiles.length > 0) {
        // Storage のパスはフォルダ名を含める必要がある
        const paths = oldFiles.map(f => `${folder}/${f.name}`)
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths)
        if (removeError) {
          console.error(`[cleanup-storage] remove error bucket=${bucket}/${folder}:`, removeError.message)
          errors += paths.length
        } else {
          deleted += paths.length
          freedBytes += oldFiles.reduce((sum, f) => sum + ((f.metadata as Record<string, number> | null)?.size ?? 0), 0)
          console.log(`[cleanup-storage] deleted ${paths.length} files from ${bucket}/${folder}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '...' : ''}`)
        }
      }

      // 全件が削除対象なら次ページへ
      if (oldFiles.length < files.length) break
      offset += PAGE_SIZE
    }

    summary[`${bucket}/${folder}`] = { deleted, errors, freedBytes }
  }

  const totalDeleted = Object.values(summary).reduce((s, v) => s + v.deleted, 0)
  const totalFreed = Object.values(summary).reduce((s, v) => s + v.freedBytes, 0)
  console.log(`[cleanup-storage] done. deleted=${totalDeleted} freed=${(totalFreed / 1024 / 1024).toFixed(1)}MB retentionDays=${retentionDays}`)

  return new Response(
    JSON.stringify({ ok: true, summary, retentionDays, cutoff: cutoffISO }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
