-- D-UNASSIGNED（パース済み添付が誰にも割り当てられない）の実例診断。
-- 該当メールの候補者ごとに、氏名・割当済み添付・メール全体の添付ラベルを並べる。読み取りのみ。
select
  left(coalesce(c.raw_profile ->> 'subject', ''), 40)              as subject,
  c.name,
  c.raw_profile ->> 'nearestStation'                                as station,
  left(coalesce((c.raw_profile -> 'attachmentNames')::text, ''), 80)         as assigned_attachments,
  left(coalesce((c.raw_profile -> 'allParsedAttachmentLabels')::text, ''), 120) as all_email_attachments
from candidates c
where c.data_env = 'prod'
  and c.merged_into is null
  and c.created_at >= now() - interval '3 days'
  and (c.raw_profile ->> 'subject' like '%のご紹介‼%'
       or c.raw_profile ->> 'subject' like '%Trinitas人材情報%')
order by c.raw_profile ->> 'subject', c.name
limit 40;
