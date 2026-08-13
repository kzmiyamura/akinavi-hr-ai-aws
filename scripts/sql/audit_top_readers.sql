-- 誰が DB を読んでいるかを pg_stat_statements で見る。
-- egress そのものは測れないが、「返した行数 × 呼ばれた回数」が実質の転送量に比例する。
-- rolname で anon（ブラウザ）/ service_role（ワーカー・スクリプト）を切り分けられる。
select
  r.rolname                                as role,
  s.calls,
  s.rows,
  round(s.total_exec_time)::bigint         as total_ms,
  left(regexp_replace(s.query, '\s+', ' ', 'g'), 110) as query
from pg_stat_statements s
join pg_roles r on r.oid = s.userid
where s.rows > 0
order by s.rows desc
limit 25;
