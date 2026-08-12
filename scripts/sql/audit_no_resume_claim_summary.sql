-- audit_no_resume_claim.sql の集計部のみ（supabase db query は最後のステートメントしか返さないため分離）
with base as (
  select
    c.drive_url,
    (c.raw_profile ->> 'attachmentText') is not null                       as has_att_text,
    coalesce(nullif(c.raw_profile ->> 'sourceAttachmentCount', '')::int, 0) as src_att,
    coalesce(jsonb_array_length(
      case when jsonb_typeof(c.raw_profile -> 'attachmentNames') = 'array'
           then c.raw_profile -> 'attachmentNames' else '[]'::jsonb end), 0) as att_names,
    coalesce(jsonb_array_length(
      case when jsonb_typeof(c.raw_profile -> 'driveLinks') = 'array'
           then c.raw_profile -> 'driveLinks' else '[]'::jsonb end), 0)     as drive_links,
    (c.raw_profile ->> '_llm_checked_at') is not null                       as ai_checked
  from candidates c
  where c.data_env = 'prod'
    and c.merged_into is null
    and c.created_at >= now() - interval '3 days'
    and c.resume_url is null
    and c.box_url is null
    and not exists (
      select 1
      from jsonb_object_keys(
        case when jsonb_typeof(c.raw_profile -> 'skillYears') = 'object'
             then c.raw_profile -> 'skillYears' else '{}'::jsonb end) k
      where k !~ '^_')
)
select
  count(*)                                                                  as total,
  count(*) filter (where drive_url is not null or drive_links > 0)          as has_drive_link,
  count(*) filter (where has_att_text)                                      as has_attachment_text,
  count(*) filter (where not has_att_text and (src_att > 0 or att_names > 0)) as attached_but_no_text,
  count(*) filter (where drive_url is null and drive_links = 0
                   and not has_att_text and src_att = 0 and att_names = 0)  as truly_nothing,
  count(*) filter (where ai_checked)                                        as ai_checked
from base;
