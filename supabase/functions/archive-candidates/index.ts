/**
 * archive-candidates Edge Function
 *
 * 7日以上経過した prod 人材データを Supabase Storage に JSONL 形式でアーカイブしてから DB 削除する。
 * pg_cron から毎日 JST 0:00 に呼び出される（delete-old-candidates cron の後継）。
 *
 * Storage パス: candidates-archive/archive/YYYY/MM/YYYY-MM-DD.jsonl
 * JSONL 1行 = 候補者 1 件の全フィールド JSON
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

  const retentionDays = 7
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)

  try {
    // ① アーカイブ対象を取得
    const { data: candidates, error: fetchError } = await supabase
      .from('candidates')
      .select('*')
      .eq('data_env', 'prod')
      .lt('created_at', cutoff.toISOString())
      .order('created_at', { ascending: true })

    if (fetchError) throw fetchError
    if (!candidates || candidates.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, archived: 0, message: 'No candidates to archive' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ② JSONL 生成（1行1件）
    const jsonl = candidates.map((c) => JSON.stringify(c)).join('\n')
    const bytes = new TextEncoder().encode(jsonl)

    // ③ Storage にアップロード（パス: archive/YYYY/MM/YYYY-MM-DD.jsonl）
    const now = new Date()
    const yyyy = now.getUTCFullYear()
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(now.getUTCDate()).padStart(2, '0')
    const storagePath = `archive/${yyyy}/${mm}/${yyyy}-${mm}-${dd}.jsonl`

    const { error: uploadError } = await supabase.storage
      .from('candidates-archive')
      .upload(storagePath, bytes, {
        contentType: 'application/x-ndjson',
        upsert: true,            // 同日再実行で上書き可
      })

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)

    // ④ アップロード成功後に DB 削除（submissions → candidates の順）
    const ids = candidates.map((c) => c.id as string)

    const { error: subError } = await supabase
      .from('submissions')
      .delete()
      .in('candidate_id', ids)
    if (subError) throw new Error(`submissions delete failed: ${subError.message}`)

    const { error: delError } = await supabase
      .from('candidates')
      .delete()
      .in('id', ids)
    if (delError) throw new Error(`candidates delete failed: ${delError.message}`)

    console.log(`[archive-candidates] archived=${candidates.length} path=${storagePath}`)

    return new Response(
      JSON.stringify({ ok: true, archived: candidates.length, path: storagePath }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[archive-candidates] error:', msg)
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
