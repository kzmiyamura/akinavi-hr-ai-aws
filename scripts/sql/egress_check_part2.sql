-- egress 総点検 その2（2026-09-23）— 保持と、1回あたりが重いもの
--
-- 見るもの:
--   ⑤ 保持が効いているか（消えるはずのものが消えているか）
--   ⑥ マッチングRPCが1回で返す量（CLAUDE.md に「1案件 約1MB」とある。今はどうか）
--   ⑦ 重複・不要行（掃除の余地）
--
-- すべて UNION ALL で1表にまとめる（db query は最後の結果しか返さない）。

with retention as (
  select 'ai_logs' as t, count(*) as n, min(created_at)::date as oldest,
         max(created_at)::date as newest,
         count(*) filter (where created_at < now() - interval '30 days') as over_30d
  from ai_logs
  union all
  -- error_logs の時刻列は created_at ではなく occurred_at（2026-09-23 に踏んだ）
  select 'error_logs', count(*), min(occurred_at)::date, max(occurred_at)::date,
         count(*) filter (where occurred_at < now() - interval '30 days')
  from error_logs
  union all
  select 'candidates(prod)', count(*), min(created_at)::date, max(created_at)::date,
         count(*) filter (where created_at < now() - interval '7 days')
  from candidates where data_env = 'prod'
  union all
  select 'llm_shadow', count(*), min(created_at)::date, max(created_at)::date,
         count(*) filter (where created_at < now() - interval '30 days')
  from llm_shadow
  union all
  select 'submissions', count(*), min(created_at)::date, max(created_at)::date,
         count(*) filter (where created_at < now() - interval '90 days')
  from submissions
),
-- ⑥ マッチングRPC が1案件あたり何バイト返すか（1案件だけで測る）。
--    **本体は返さない**。SQL 側で json にしてバイト数だけ数える（CLAUDE.md の鉄則）。
--    引数は実物の並びに合わせること（p_data_env, p_required_skills, ... の20個）。
rpc as (
  select octet_length(json_agg(r)::text) as bytes, count(*) as rows
  from (
    select * from fetch_candidates_for_project(
      'prod',                       -- p_data_env
      array['Java','Python'],       -- p_required_skills
      500000, 900000,               -- p_budget_min / max
      '東京', 'onsite',             -- p_work_location / p_remote_policy
      500,                          -- p_limit（画面と同じ上限で測る）
      40, 20, 15, 15, 10,           -- 各ウェイト
      false, '準委任', '東京都', 3,
      null, null, null, 0
    )
  ) r
),
dupes as (
  select
    count(*) filter (where duplicate_flag) as dup_flagged,
    count(*) filter (where merged_into is not null) as merged,
    count(*) filter (where raw_profile->>'_llm_quarantined' is not null) as quarantined
  from candidates where data_env = 'prod'
)
select * from (
  select 5 as ord, '⑤ 保持' as section, t as item,
         n::text as v1, ('最古 ' || oldest || ' / 最新 ' || newest) as v2,
         case when over_30d > 0 then '期限超過 ' || over_30d || '件' else 'OK' end as note
  from retention
  union all
  select 6, '⑥ マッチングRPC', '1案件が返す量',
         pg_size_pretty(bytes::bigint), rows::text || '人', 'クリック1回ぶん'
  from rpc
  union all
  select 7, '⑦ 掃除の余地', '重複フラグ', dup_flagged::text, '', '' from dupes
  union all
  select 7, '⑦ 掃除の余地', 'マージ済み', merged::text, '', '' from dupes
  union all
  select 7, '⑦ 掃除の余地', '隔離済み', quarantined::text, '', '' from dupes
) z
order by ord, section, item;
