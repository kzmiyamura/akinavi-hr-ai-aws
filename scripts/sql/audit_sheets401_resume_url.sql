-- Sheets 401（A-FETCH-FAIL）メールの候補者に resume_url / 本文リンクが残っているかの検証。読み取りのみ。
-- 対象: trace の emailCodes か summary に A-FETCH-FAIL を含むメールの候補者。
with hit as (
  select
    c.id, c.name, c.resume_url, c.drive_url,
    (c.raw_profile ->> 'text') like '%docs.google.com%'
      or (c.raw_profile ->> 'text') like '%drive.google.com%'   as body_has_glink,
    left(coalesce(c.raw_profile ->> 'subject', ''), 35) as subject
  from candidates c
  where c.data_env = 'prod'
    and c.merged_into is null
    and c.created_at >= now() - interval '3 days'
    and (c.raw_profile -> 'pipeline_trace')::text like '%A-FETCH-FAIL%'
)
select
  count(*)                                             as total,
  count(*) filter (where resume_url is not null)       as has_resume_url,
  count(*) filter (where resume_url like '%google%')   as resume_url_google,
  count(*) filter (where drive_url is not null)        as has_drive_url,
  count(*) filter (where body_has_glink)               as body_has_google_link,
  count(*) filter (where resume_url is null and drive_url is null) as no_link_saved
from hit;
