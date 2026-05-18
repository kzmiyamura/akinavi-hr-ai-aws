// Supabase Edge Function: skill-master-cleanup
// 毎日 JST 3:00 に実行（pg_cron から呼び出し）
// AI を使わずルールベースで skill_master のゴミエントリを削除する

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ゴミ判定ルール（AIなし・完全ルールベース）
// source='ai' のエントリのみ対象（seed は削除しない）
const GARBAGE_PATTERNS: RegExp[] = [
  /^.{1}$/,                 // 1文字のみ
  /^\d+$/,                  // 数字のみ（バージョン番号等）
  /^\d[\d.]+$/,             // バージョン番号のみ (1.0, 2.3.4)
  /^[ぁ-ん]{1,4}$/,        // 短いひらがな（4文字以内）
  /^[ァ-ン]{1,2}$/,        // 短いカタカナ（2文字以内）
  /^(経験|以上|あり|なし|可能|対応|担当|実績|設計|構築|運用|管理|提案|分析|作成|実装|習得|使用|利用|活用|業務|機能|処理|連携|統合|移行|更新|保守|改修|対象|必要|要件|希望|優遇|歓迎|必須|尚可|概要|詳細|内容|期間|場所|条件|契約|稼働|即日|その他|各種|開発|構成|制作|作業|登録|入力|確認|レビュー|テスト|修正|調整|検討|調査|収集|整理|管理|設定)$/,
  /^\s*$/,                  // 空白のみ
  /^[.,:;!?。、：；！？]{1,3}$/, // 句読点のみ
]

function isGarbage(name: string): boolean {
  const trimmed = name.trim()
  // 2文字未満は常にゴミ
  if (trimmed.length < 2) return true
  // 60文字超は異常に長い
  if (trimmed.length > 60) return true
  return GARBAGE_PATTERNS.some(p => p.test(trimmed))
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const results = {
    rule_deleted: 0,
    stale_deleted: 0,
    errors: [] as string[],
  }

  try {
    // 1. ルールベースゴミ削除（source='ai' のみ対象）
    const { data: aiSkills, error: fetchErr } = await supabase
      .from('skill_master')
      .select('id, name')
      .eq('source', 'ai')

    if (fetchErr) {
      results.errors.push(`fetch_ai_skills: ${fetchErr.message}`)
    } else if (aiSkills && aiSkills.length > 0) {
      const garbageIds = aiSkills
        .filter(s => isGarbage(s.name))
        .map(s => s.id)

      if (garbageIds.length > 0) {
        const { error: delErr } = await supabase
          .from('skill_master')
          .delete()
          .in('id', garbageIds)

        if (delErr) {
          results.errors.push(`rule_delete: ${delErr.message}`)
        } else {
          results.rule_deleted = garbageIds.length
          console.log(`[skill-master-cleanup] ルール削除: ${garbageIds.length}件`)
        }
      }
    }

    // 2. 30日間マッチなし（source='ai' かつ match_count=0）を削除
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: staleSkills, error: staleErr } = await supabase
      .from('skill_master')
      .select('id, name')
      .eq('source', 'ai')
      .eq('match_count', 0)
      .lt('created_at', cutoff)

    if (staleErr) {
      results.errors.push(`fetch_stale: ${staleErr.message}`)
    } else if (staleSkills && staleSkills.length > 0) {
      const staleIds = staleSkills.map(s => s.id)
      const { error: staleDelErr } = await supabase
        .from('skill_master')
        .delete()
        .in('id', staleIds)

      if (staleDelErr) {
        results.errors.push(`stale_delete: ${staleDelErr.message}`)
      } else {
        results.stale_deleted = staleIds.length
        console.log(`[skill-master-cleanup] 30日間未マッチ削除: ${staleIds.length}件`)
      }
    }

    console.log(
      `[skill-master-cleanup] 完了 rule_deleted=${results.rule_deleted} stale_deleted=${results.stale_deleted} errors=${results.errors.length}`,
    )

    return new Response(
      JSON.stringify({ ok: true, ...results }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )
  } catch (e) {
    const msg = String(e)
    console.error('[skill-master-cleanup] 予期しないエラー:', msg)
    return new Response(
      JSON.stringify({ ok: false, error: msg, ...results }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )
  }
})
