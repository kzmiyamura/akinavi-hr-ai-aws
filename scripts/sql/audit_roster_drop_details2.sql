-- audit_roster_drop_details.sql の続き: A-FETCH-FAIL 以外の取りこぼし系コードの詳細。
-- C-ROSTER-CAP は detail が「元行数→上限」なので、切り捨てた人数がそのまま読める。
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
select left(s.code, 90) as code_detail,
       subject,
       count(*)         as cnt
from emails,
     jsonb_each_text(
       case when jsonb_typeof(trace -> 'summary') = 'object'
            then trace -> 'summary' else '{}'::jsonb end) s(entry_id, code)
where split_part(s.code, '(', 1) in ('C-ROSTER-CAP', 'C-ROW-LINK-SKIP', 'D-UNASSIGNED')
group by 1, 2
order by 1, 3 desc
limit 40;
