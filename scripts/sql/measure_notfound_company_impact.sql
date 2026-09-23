-- 「照合できず」の会社に所属する人材が、派遣案件からどれだけ消えているか（2026-09-23）
--
-- agent_companies の内訳（実測）:
--   haken 123 / notfound 101 / both 10 / shokai 1 / unknown 0 / none 0
--
-- fetch_candidates_for_project の p_require_haken は haken / both しか通さない。
-- notfound は「厚労省サイトで引けなかった」だけで免許が無いとは限らないのに、
-- 派遣案件では**その会社の人材が丸ごと候補から消える**。
-- 何人が消えているのかを数える。

with c as (
  select
    lower(split_part(raw_profile->>'from', '@', 2)) as domain
  from candidates
  where data_env = 'prod' and merged_into is null and duplicate_flag = false
)
select
  coalesce(ac.license_status, '(会社未登録)')       as "免許の状態",
  count(*)                                          as "人材数",
  round(100.0 * count(*) / sum(count(*)) over (), 1) as "割合%",
  count(distinct c.domain)                          as "会社数"
from c
left join agent_companies ac on ac.domain = c.domain
group by 1
order by 2 desc;
