-- 「経歴書なし・リンクもなし」（audit_skillyears_gap.mjs の noResumeNoBox 群）の検証。
-- その分類は resume_url / box_url 列しか見ていないが、inbound-email は raw_profile に
-- 添付の実態（sourceAttachmentCount / attachmentNames / attachmentText / driveLinks）を残している。
-- 「本当に入力が無い」のか「添付はあったのに経歴書として扱えていない」のかを切り分ける。
-- 読み取りのみ。集計はサーバー側で行い egress を使わない。
with base as (
  select
    c.id,
    c.name,
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

-- 「添付テキストあり」「添付あり・テキストなし」の実例（名前は先頭のみ）
with base as (
  select
    c.name,
    c.drive_url,
    (c.raw_profile ->> 'attachmentText') is not null                       as has_att_text,
    coalesce(nullif(c.raw_profile ->> 'sourceAttachmentCount', '')::int, 0) as src_att,
    coalesce(jsonb_array_length(
      case when jsonb_typeof(c.raw_profile -> 'attachmentNames') = 'array'
           then c.raw_profile -> 'attachmentNames' else '[]'::jsonb end), 0) as att_names,
    case when jsonb_typeof(c.raw_profile -> 'attachmentNames') = 'array'
         then (select string_agg(left(x, 40), ' | ')
               from jsonb_array_elements_text(c.raw_profile -> 'attachmentNames') x)
         else null end                                                      as att_name_list,
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
select left(coalesce(name, ''), 8) as name,
       has_att_text, src_att, att_names, ai_checked,
       left(coalesce(att_name_list, ''), 80) as attachments
from base
where has_att_text or src_att > 0 or att_names > 0
order by has_att_text desc, src_att desc
limit 15;
