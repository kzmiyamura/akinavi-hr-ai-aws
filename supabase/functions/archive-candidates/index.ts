/**
 * archive-candidates Edge Function
 *
 * 7日以上経過した prod 人材データを candidates_archive_light に保存してから DB 削除する。
 * pg_cron から毎日 JST 0:00 に呼び出される。
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
      .select('id, data_env, name, raw_profile, skills, created_at')
      .eq('data_env', 'prod')
      .lt('created_at', cutoff.toISOString())
      .order('created_at', { ascending: true })
      .limit(5000)

    if (fetchError) throw fetchError
    if (!candidates || candidates.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, archived: 0, message: 'No candidates to archive' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const ids = candidates.map((c) => c.id as string)

    // ② candidates_archive_light にサマリーを保存（ヒートマップ全期間集計用）
    const lightRows = candidates.map((c) => ({
      id: c.id as string,
      data_env: c.data_env as string,
      prefecture: (c.raw_profile as Record<string, string> | null)?.prefecture ?? null,
      skills: c.skills ?? [],
      created_at: c.created_at as string,
      name: (c.name as string | null) ?? null,
      subject: (c.raw_profile as Record<string, string> | null)?.subject ?? null,
    }))

    const { error: lightError } = await supabase
      .from('candidates_archive_light')
      .upsert(lightRows, { onConflict: 'id' })
    if (lightError) throw new Error(`candidates_archive_light upsert failed: ${lightError.message}`)

    // ③ DB 削除（submissions → candidates の順）
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

    console.log(`[archive-candidates] archived=${candidates.length}`)

    return new Response(
      JSON.stringify({ ok: true, archived: candidates.length }),
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
