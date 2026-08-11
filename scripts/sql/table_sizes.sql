-- テーブルごとの容量。無料枠のDB上限（500MB）に対する圧迫度と、
-- ThinkCentre へ移す価値があるかの判断材料にする（読み取りのみ）
select
  relname as table_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total,
  pg_total_relation_size(c.oid) as bytes,
  (select reltuples::bigint from pg_class where oid = c.oid) as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 15;
