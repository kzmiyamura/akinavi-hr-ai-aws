-- ============================================================================
-- 取引先（BP）ごとの通信簿を会社管理画面に出すためのビュー
-- ============================================================================
-- 2026-09-19〜20 の調査で、取引先ごとに**送ってくる人材の性格がはっきり違う**
-- ことが実測で分かった（ローカル控え4,313人）:
--
--   i-standard.jp   292人  単価80万  経験26年 51歳  添付35%   自社99%  ← ベテラン専門
--   ai-more.co.jp   217人  単価55万  経験 8年 32歳  添付87%   自社11%  ← 若手・又聞き
--   free-brain.co.jp 179人 単価75万  経験27年 53歳  添付99%   自社100% ← 書類が揃う
--   j-tech.co.jp    146人  単価70万  経験20年 46歳  添付10%   自社97%  ← 経歴書が来ない
--
-- 「経歴書添付率10%」は毎回こちらから催促が要るという運用コストそのもので、
-- 取引先に改善を依頼する根拠になる。画面に出していなかったので足す。
--
-- ⚠ 画面から人材を1行も引かずに済むよう、**集計はここで閉じる**。
--    ブラウザが candidates を読むと egress を食う（CLAUDE.md の鉄則）。
--    1社1行・約300行しか返らない。
--
-- ⚠ 希望単価は「55～60万」「75万円」等の自由記述。数字を取り出して平均する。
--    範囲は中央値を採る（resume_signals.mjs / market_report.mjs と同じ考え方）。
-- ============================================================================

create or replace view public.agent_company_stats as
with base as (
  select
    lower(split_part(c.raw_profile->>'from', '@', 2)) as domain,
    c.experience_years,
    (c.raw_profile->>'age')::int                       as age,
    c.raw_profile->>'commercialFlow'                   as flow,
    c.resume_url,
    c.created_at,
    -- 「55～60万」→ 57.5 / 「75万円」→ 75。取れなければ null
    -- regexp_matches は text[] を返すので m[1] で取り出す。
    -- ⚠ 全角数字（「６０万」）が実データにある。\d は全角も拾ってしまい numeric に
    --   キャストできず 22P02 で落ちるので、**先に半角へ寄せて [0-9] で取る**。
    (
      select avg(m[1]::numeric)
      from regexp_matches(
             translate(coalesce(c.desired_rate, ''), '０１２３４５６７８９', '0123456789'),
             '([0-9]{2,3})[ 　]*万', 'g') as m
      where m[1]::numeric between 20 and 300
    ) as rate
  from public.candidates c
  where c.data_env = 'prod'
    and c.merged_into is null
    and c.raw_profile->>'from' is not null
)
select
  domain,
  count(*)                                                as people,
  -- 中央値。平均だと1人の極端な値に引きずられる
  percentile_cont(0.5) within group (order by rate)       as rate_median,
  percentile_cont(0.25) within group (order by rate)      as rate_p25,
  percentile_cont(0.75) within group (order by rate)      as rate_p75,
  percentile_cont(0.5) within group (order by experience_years)
    filter (where experience_years is not null)           as exp_median,
  percentile_cont(0.5) within group (order by age)
    filter (where age is not null)                        as age_median,
  -- 経歴書が付いてくる割合。低い会社は毎回催促が要る
  round(100.0 * count(*) filter (
    where resume_url ~* '\.(xlsx?|xlsm|docx?|pdf)($|\?)') / count(*), 0)::int as attach_pct,
  -- 自社要員の割合。低いほど又聞き（間に会社が挟まる）
  round(100.0 * count(*) filter (where flow = '自社') / count(*), 0)::int     as own_pct,
  max(created_at)                                         as last_seen_at,
  count(*) filter (where created_at >= now() - interval '7 days')            as people_7d
from base
where domain is not null and domain <> ''
group by domain;

comment on view public.agent_company_stats is
  '取引先ごとの人材の傾向（人数・単価中央値・経験・年齢・経歴書添付率・自社比率）。会社管理画面用。集計済みなので画面から candidates を引かなくてよい。';

grant select on public.agent_company_stats to anon, authenticated;
