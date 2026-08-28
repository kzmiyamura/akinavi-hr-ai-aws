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

  // 保持日数はフォルダごとに分ける（2026-08-28）。
  //   resumes/ … 営業が画面から開く経歴書。短くすると業務が困る
  //   raw/     … poll-email が残す受信添付の控え。アプリからは一切読まれない
  // 実測では raw/ が全体の88%（1,198MB / 1,359MB）を占めており、経歴書を削っても
  // 容量は減らない。読まれない側を短くするのが正しい。
  const getDays = async (key: string, fallback: number): Promise<number> => {
    const { data } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle()
    const v = parseInt(String(data?.value ?? ''), 10)
    return isNaN(v) || v < 1 ? fallback : v
  }
  const retentionDays = await getDays('storage_retention_days', 7)
  const rawRetentionDays = await getDays('raw_retention_days', 2)

  const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()
  const cutoffISO = isoDaysAgo(retentionDays)
  const rawCutoffISO = isoDaysAgo(rawRetentionDays)

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

  // ── raw/<messageId>/ 配下（受信添付の実体・2026-08-19 追加） ──
  // 割り当て成否と無関係に poll-email が保存する調査用の実体。resumes/ と違い
  // 1階層深いので、サブフォルダを列挙してから中のファイルを見る。
  // ここを掃除しないと無制限に増える（PIIを抱え続けることにもなる）。
  {
    const bucket = 'attachments'
    let deleted = 0
    let errors = 0
    let freedBytes = 0
    // フォルダは offset で最後まで辿る。以前は limit:1000 の1回だけで打ち切っており、
    // 5,000件を超えた時点で残りに永久に到達しなかった（2026-08-28 実測で 7,466 フォルダ、
    // うち掃除できていたのは先頭1,000件ぶんだけ）。
    // フォルダのプレースホルダには created_at が無いので、日付は中のファイルで判定する。
    // 実行時間には上限があるので、使い切ったら次回に続きを任せる（毎日走るので追いつく）。
    const BUDGET_MS = 110_000
    const startedAt = Date.now()
    let scanned = 0
    let exhausted = false
    for (let offset = 0; ;) {
      if (Date.now() - startedAt > BUDGET_MS) break
      const { data: folders, error: folderError } = await supabase.storage
        .from(bucket).list('raw', { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
      if (folderError) {
        console.error('[cleanup-storage] list error attachments/raw:', folderError.message)
        errors++
        break
      }
      if (!folders || folders.length === 0) { exhausted = true; break }
      let emptied = 0
      for (const f of folders) {
        scanned++
        const { data: files, error: listError } = await supabase.storage
          .from(bucket).list(`raw/${f.name}`, { limit: 100 })
        if (listError) { errors++; continue }
        const oldFiles = (files ?? []).filter((x) => {
          const created = x.created_at ?? (x.metadata as Record<string, string> | null)?.lastModified
          return !created || created < rawCutoffISO
        })
        if (oldFiles.length === 0) continue
        const paths = oldFiles.map((x) => `raw/${f.name}/${x.name}`)
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths)
        if (removeError) {
          console.error(`[cleanup-storage] remove error raw/${f.name}:`, removeError.message)
          errors += paths.length
          continue
        }
        deleted += paths.length
        freedBytes += oldFiles.reduce((sum, x) => sum + ((x.metadata as Record<string, number> | null)?.size ?? 0), 0)
        if (oldFiles.length === (files ?? []).length) emptied++
      }
      if (folders.length < 100) { exhausted = true; break }
      // 空になったフォルダは一覧から消え、後続がその分だけ繰り上がる。
      // 単純に +100 すると繰り上がったぶんを読み飛ばすので、消えた数を差し引く。
      offset += folders.length - emptied
    }
    summary['attachments/raw'] = { deleted, errors, freedBytes }
    console.log(`[cleanup-storage] attachments/raw scanned=${scanned} deleted=${deleted} errors=${errors} exhausted=${exhausted} cutoff=${rawCutoffISO}`)
  }

  const totalDeleted = Object.values(summary).reduce((s, v) => s + v.deleted, 0)
  const totalFreed = Object.values(summary).reduce((s, v) => s + v.freedBytes, 0)
  console.log(`[cleanup-storage] done. deleted=${totalDeleted} freed=${(totalFreed / 1024 / 1024).toFixed(1)}MB retentionDays=${retentionDays}`)

  return new Response(
    // 実際に使った保持日数と締切を応答に含める（設定が効いているかを外から確認するため）
    JSON.stringify({ ok: true, summary, retentionDays, cutoff: cutoffISO, rawRetentionDays, rawCutoff: rawCutoffISO }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
