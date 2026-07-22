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
    const PAGE_SIZE = 100
    // created_at 昇順で常に先頭ページを読む。削除でリストが縮むと次の最古ファイルが
    // 先頭に繰り上がるため、offset は進めない（進めると削除で詰めた分を読み飛ばす）。
    // 安全弁: 想定件数を大きく超えたら中断（無限ループ防止）
    const MAX_ITERS = 100000
    let iter = 0

    while (iter++ < MAX_ITERS) {
      const { data: files, error: listError } = await supabase.storage
        .from(bucket)
        .list(folder, { limit: PAGE_SIZE, offset: 0, sortBy: { column: 'created_at', order: 'asc' } })

      if (listError) {
        console.error(`[cleanup-storage] list error bucket=${bucket}/${folder}:`, listError.message)
        break
      }
      if (!files || files.length === 0) break

      // cutoff より古いファイルだけ対象（created_at がない場合も削除対象にする）。
      // 昇順ソートなので古いファイルは必ず先頭に固まる = oldFiles は先頭からの連続。
      const oldFiles = files.filter(f => {
        const created = f.created_at ?? (f.metadata as Record<string, string> | null)?.lastModified
        return !created || created < cutoffISO
      })

      // 先頭ページに削除対象が無い = 残りは全て cutoff より新しい → 完了
      if (oldFiles.length === 0) break

      // Storage のパスはフォルダ名を含める必要がある
      const paths = oldFiles.map(f => `${folder}/${f.name}`)
      const { error: removeError } = await supabase.storage.from(bucket).remove(paths)
      if (removeError) {
        // 削除に失敗すると同じファイルを再listしてしまい無限ループになるため中断
        console.error(`[cleanup-storage] remove error bucket=${bucket}/${folder}:`, removeError.message)
        errors += paths.length
        break
      }

      deleted += paths.length
      freedBytes += oldFiles.reduce((sum, f) => sum + ((f.metadata as Record<string, number> | null)?.size ?? 0), 0)
      console.log(`[cleanup-storage] deleted ${paths.length} files from ${bucket}/${folder}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '...' : ''}`)

      // 削除したファイルを参照している candidates.resume_url を NULL クリア
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
      const publicUrlPrefix = `${supabaseUrl}/storage/v1/object/public/${bucket}/`
      const deletedUrls = paths.map(p => `${publicUrlPrefix}${p}`)
      const { error: urlClearError } = await supabase
        .from('candidates')
        .update({ resume_url: null })
        .in('resume_url', deletedUrls)
      if (urlClearError) {
        console.error(`[cleanup-storage] resume_url clear error:`, urlClearError.message)
      } else {
        console.log(`[cleanup-storage] cleared resume_url for up to ${deletedUrls.length} candidates`)
      }

      // このページに新しいファイルが混じっていた = 古いものは全て消し終えた → 完了
      if (oldFiles.length < files.length) break
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
