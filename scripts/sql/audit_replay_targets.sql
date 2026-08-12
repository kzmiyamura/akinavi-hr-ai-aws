-- 再解析（bulk replay）候補の把握: 経歴書(resume_url)ありで skillYears が空の prod 人材。
-- 総経験年数(experience_years)の有無も分けて数える。読み取りのみ。
with base as (
  select
    c.id,
    c.resume_url,
    c.experience_years,
    (c.raw_profile ->> '_llm_checked_at') is not null as ai_checked,
    lower(c.resume_url) ~ '\.pdf(\?|$)'   as is_pdf,
    c.resume_url like '%supabase.co/storage%'         as in_storage,
    c.created_at
  from candidates c
  where c.data_env = 'prod'
    and c.merged_into is null
    and c.created_at >= now() - interval '7 days'
    and c.resume_url is not null
    and not exists (
      select 1
      from jsonb_object_keys(
        case when jsonb_typeof(c.raw_profile -> 'skillYears') = 'object'
             then c.raw_profile -> 'skillYears' else '{}'::jsonb end) k
      where k !~ '^_')
)
select
  count(*)                                                   as total_no_skillyears,
  count(*) filter (where experience_years is null)           as also_no_exp_years,
  count(*) filter (where in_storage)                         as resume_in_storage,
  count(*) filter (where not in_storage)                     as resume_external_link,
  count(*) filter (where is_pdf)                             as pdf,
  count(*) filter (where ai_checked)                         as ai_checked
from base;
