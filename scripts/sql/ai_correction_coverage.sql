-- AI校正がどれだけ追いつけているかを、件数だけで測る（2026-09-22）
--
-- 常駐ワーカーは日次上限（app_config.shadow_max_per_day）に張り付いており、
-- ログには「ペース配分により待機」が並ぶ。つまり処理能力が制約になっている。
-- ここで見たいのは「到着に対してどれだけ校正できているか」と
-- 「未処理の山がどれくらい積んであるか」。
--
-- 本文や raw_profile は一切返さない。すべて count だけ（egress ゼロ設計）。
--
-- 実行: npx supabase db query --linked -f scripts/sql/ai_correction_coverage.sql

with d as (
  select
    (created_at at time zone 'Asia/Tokyo')::date as jst_day,
    raw_profile->>'_llm_checked_at' is not null   as checked,
    resume_url is not null                        as has_resume
  from candidates
  where data_env = 'prod'
    and merged_into is null
    and created_at >= now() - interval '7 days'
)
select
  jst_day                                             as "日付(JST)",
  count(*)                                            as "登録",
  count(*) filter (where checked)                     as "AI校正済",
  round(100.0 * count(*) filter (where checked) / nullif(count(*), 0)) as "％",
  count(*) filter (where has_resume)                  as "経歴書あり",
  count(*) filter (where has_resume and not checked)  as "経歴書ありで未校正"
from d
group by jst_day
order by jst_day desc;
