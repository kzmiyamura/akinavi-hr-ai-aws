-- Free プランに戻せるかを測る（2026-09-26）
-- Free の壁: DB 500MB / Storage 1GB / egress 5GB/月 / Edge Function 500K呼び出し/月
-- 本体は1行も返さない。サイズと件数だけ。
WITH db AS (
  SELECT 'DB全体' AS 項目,
         pg_size_pretty(pg_database_size(current_database())) AS 値,
         round(pg_database_size(current_database())/1048576.0) AS mb,
         0 AS ord
),
tbl AS (
  SELECT '表: '||relname,
         pg_size_pretty(pg_total_relation_size(c.oid)),
         round(pg_total_relation_size(c.oid)/1048576.0),
         1
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8
),
stor AS (
  SELECT 'Storage: '||bucket_id,
         pg_size_pretty(sum((metadata->>'size')::bigint)),
         round(sum((metadata->>'size')::bigint)/1048576.0),
         2
  FROM storage.objects GROUP BY bucket_id
)
SELECT * FROM db
UNION ALL SELECT * FROM tbl
UNION ALL SELECT * FROM stor
ORDER BY 4, 3 DESC;
