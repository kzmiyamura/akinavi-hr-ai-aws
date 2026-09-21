-- ============================================================================
-- agent_companies に溜まったスパム送信元を「消す前に一覧で見る」
-- ============================================================================
-- この表は入口だけあって出口が無い。人材は7日で消えるが会社は永久に残るため、
-- フィッシングの送信元が「派遣・紹介会社」として画面に居座る。
--   実害（2026-09-21 ユーザー指摘）: 「Amazon.com, Inc.」が3社並んでいた。
--   送信元は mail17.hytjy.com / mail08.hytjy.com / mail03.wxyysb.com。
--
-- ⚠ 人材が0人＝ゴミ、ではない。保持7日を過ぎて全員アーカイブに移っただけの
--    正常な取引先が77社ある。**その77社を巻き込まないこと**が一番大事。
--    ここでは「今いる人材が全員『人ではない』」か「有名企業名を騙っている」に限る。
--
-- 消すのは scripts/sql/delete_junk_agent_companies.sql（人が一覧を見てから流す）。
-- ============================================================================
with live as (
  select lower(split_part(raw_profile->>'from','@',2)) as domain,
         count(*) as n,
         count(*) filter (
           where (name is null or name in ('不明','氏名未取得',''))
             and raw_profile->>'age' is null and raw_profile->>'gender' is null
             and desired_rate is null and raw_profile->>'nearestStation' is null
             and experience_years is null) as not_person
  from public.candidates
  where data_env = 'prod' and merged_into is null
  group by 1
)
select
  a.domain,
  a.company_name,
  a.license_status,
  a.first_seen_at::date as 初回,
  coalesce(l.n, 0)          as 今いる人材,
  coalesce(l.not_person, 0) as うち人ではない,
  case
    when a.company_name ~* '(amazon|apple|google|microsoft|jcb|rakuten|三井住友|三菱UFJ|セブン|ヤマト|佐川|えきねっと|ETC|国税|年金|WADAX)'
      then '有名企業名を騙っている'
    when l.n > 0 and l.not_person = l.n then '今いる人材が全員「人ではない」'
    else '?'
  end as 理由
from public.agent_companies a
left join live l on l.domain = a.domain
where
  a.company_name ~* '(amazon|apple|google|microsoft|jcb|rakuten|三井住友|三菱UFJ|セブン|ヤマト|佐川|えきねっと|ETC|国税|年金|WADAX)'
  or (l.n > 0 and l.not_person = l.n)
order by 理由, a.first_seen_at desc;
