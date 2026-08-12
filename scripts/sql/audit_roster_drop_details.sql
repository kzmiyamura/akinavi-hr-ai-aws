-- 名簿取りこぼしの詳細: C-ROSTER-CAP（何行→何行に切ったか）と
-- A-FETCH-FAIL / C-ROW-LINK-SKIP / D-UNASSIGNED の内訳。読み取りのみ。
with emails as (
  select distinct on (
      c.raw_profile ->> 'from',
      c.raw_profile ->> 'subject',
      c.raw_profile ->> 'emailReceivedAt')
    left(coalesce(c.raw_profile ->> 'subject', ''), 45) as subject,
    c.raw_profile -> 'pipeline_trace' as trace
  from candidates c
  where c.data_env = 'prod'
    and c.merged_into is null
    and c.created_at >= now() - interval '3 days'
    and c.raw_profile ? 'pipeline_trace'
)
select split_part(s.code, '(', 1) as code,
       left(s.code, 90)           as code_detail,
       subject,
       count(*)                   as cnt
from emails,
     jsonb_each_text(
       case when jsonb_typeof(trace -> 'summary') = 'object'
            then trace -> 'summary' else '{}'::jsonb end) s(entry_id, code)
where split_part(s.code, '(', 1) in ('C-ROSTER-CAP', 'A-FETCH-FAIL', 'C-ROW-LINK-SKIP', 'D-UNASSIGNED')
group by 1, 2, 3
order by 1, 4 desc
limit 60;
