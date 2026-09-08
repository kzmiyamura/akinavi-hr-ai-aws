/**
 * cleanup-storage Edge Function
 *
 * Supabase Storage に蓄積した古いファイルを削除して枠を回復する。
 * pg_cron から毎日 JST 1:00 に呼び出される。
 *
 * 対象: attachments バケットの resumes/ と raw/
 * 削除基準: created_at が保持日数以上前のオブジェクト
 *   resumes/ … 営業が画面から開く経歴書（storage_retention_days・既定7日）
 *   raw/     … poll-email が残す受信添付の控え。アプリからは一切読まれない
 *              （raw_retention_days・既定2日）
 *
 * ⚠ 削除対象は **DB（storage.objects）に聞く**。Storage API の list でフォルダを
 *   辿ってはいけない。過去2回、同じ理由で掃除が止まっている:
 *     2026-08-28  limit:1000 の1回だけで打ち切り、5,000件目以降に永久に到達しなかった
 *     2026-09-09  110秒の予算で中断する作りにしたが、再開位置を持たないので毎回
 *                 offset 0 から走り直し、予算内に届かない後半が永久に残った
 *                 （raw_retention_days=1 なのに 1,880件・319MB が残存）
 *   list は「どこまで消したか」を持てない。DB に聞けば、古いものだけが必ず先に返る。
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

/** Storage の remove は1回あたりの件数に上限があるので分割する */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 削除してよいパスだけを残す。RPC が想定外のプレフィックスを返しても、
 * 掃除対象のフォルダ外を消さないための最後の関門。
 */
export function pathsUnderPrefix(paths: readonly string[], prefix: string): string[] {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  return paths.filter((x) => x.startsWith(p) && !x.includes('..'))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

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

  const BUCKET = 'attachments'
  const PAGE = 500          // 1回のRPCで引く削除対象の件数
  const REMOVE_BATCH = 100  // Storage remove の1回あたり件数
  const BUDGET_MS = 110_000

  const summary: Record<string, {
    deleted: number; errors: number; freedBytes: number; remaining: boolean
  }> = {}

  /**
   * prefix 配下の古いファイルを消す。
   * 削除するたびに対象は減るので、常に「今いちばん古い PAGE 件」を引き直せばよい。
   * 予算切れで途中終了しても、次回は残った最古から再開される（再開位置を持つ必要がない）。
   */
  const sweep = async (prefix: string, cutoff: string, onDeleted?: (paths: string[]) => Promise<void>) => {
    let deleted = 0
    let errors = 0
    let freedBytes = 0
    let remaining = false
    const startedAt = Date.now()

    for (;;) {
      if (Date.now() - startedAt > BUDGET_MS) { remaining = true; break }

      const { data: rows, error } = await supabase.rpc('list_old_storage_objects', {
        p_bucket: BUCKET, p_prefix: `${prefix}/`, p_cutoff: cutoff, p_limit: PAGE,
      })
      if (error) {
        console.error(`[cleanup-storage] rpc error ${prefix}:`, error.message)
        errors++
        break
      }
      const targets = (rows ?? []) as { path: string; bytes: number }[]
      if (targets.length === 0) break

      const sizeOf = new Map(targets.map((t) => [t.path, Number(t.bytes) || 0]))
      const paths = pathsUnderPrefix(targets.map((t) => t.path), prefix)
      if (paths.length !== targets.length) {
        console.error(`[cleanup-storage] ${prefix}: 想定外のパスを ${targets.length - paths.length} 件除外した`)
      }
      if (paths.length === 0) break

      let progressed = false
      for (const batch of chunk(paths, REMOVE_BATCH)) {
        const { error: removeError } = await supabase.storage.from(BUCKET).remove(batch)
        if (removeError) {
          console.error(`[cleanup-storage] remove error ${prefix}:`, removeError.message)
          errors += batch.length
          continue
        }
        deleted += batch.length
        freedBytes += batch.reduce((s, p) => s + (sizeOf.get(p) ?? 0), 0)
        progressed = true
        if (onDeleted) await onDeleted(batch)
      }

      // 1件も消せなかった = 同じ対象を引き直すだけなので打ち切る（無限ループ防止）
      if (!progressed) { remaining = true; break }
    }

    console.log(`[cleanup-storage] ${prefix} deleted=${deleted} errors=${errors} `
      + `freed=${(freedBytes / 1048576).toFixed(1)}MB remaining=${remaining} cutoff=${cutoff}`)
    summary[`${BUCKET}/${prefix}`] = { deleted, errors, freedBytes, remaining }
  }

  // resumes/ — 消したら candidates.resume_url も外す（リンク切れを残さない）
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const publicUrlPrefix = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/`
  await sweep('resumes', cutoffISO, async (paths) => {
    const urls = paths.map((p) => `${publicUrlPrefix}${p}`)
    const { error } = await supabase.from('candidates').update({ resume_url: null }).in('resume_url', urls)
    if (error) console.error('[cleanup-storage] resume_url clear error:', error.message)
  })

  // raw/ — アプリから読まれない受信添付の控え。PIIを抱え続けないよう短く保つ
  await sweep('raw', rawCutoffISO)

  const totalDeleted = Object.values(summary).reduce((s, v) => s + v.deleted, 0)
  const totalFreed = Object.values(summary).reduce((s, v) => s + v.freedBytes, 0)
  const incomplete = Object.values(summary).some((v) => v.remaining)
  console.log(`[cleanup-storage] done. deleted=${totalDeleted} `
    + `freed=${(totalFreed / 1048576).toFixed(1)}MB retentionDays=${retentionDays} incomplete=${incomplete}`)

  return new Response(
    // 実際に使った保持日数と締切を応答に含める（設定が効いているかを外から確認するため）。
    // incomplete=true は「予算切れで残りがある」= 翌日の実行で続きが消える
    JSON.stringify({
      ok: true, summary, retentionDays, cutoff: cutoffISO,
      rawRetentionDays, rawCutoff: rawCutoffISO, incomplete,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
