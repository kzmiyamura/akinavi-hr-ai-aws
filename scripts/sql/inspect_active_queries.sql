-- 接続の詰まりを見る。長時間居座っているクエリとロール別の接続数。
-- statement_timeout を引き上げた直後に画面が重くなったときはここを見る。
SELECT
  count(*)                                                        AS 接続数,
  count(*) FILTER (WHERE state = 'active')                        AS 実行中,
  count(*) FILTER (WHERE state = 'idle in transaction')           AS トランザクション放置,
  max(EXTRACT(epoch FROM (now() - query_start)))::int             AS 最長実行秒
FROM pg_stat_activity
WHERE datname = current_database();

SELECT
  usename                                             AS ロール,
  state,
  EXTRACT(epoch FROM (now() - query_start))::int      AS 実行秒,
  left(regexp_replace(query, '\s+', ' ', 'g'), 90)    AS クエリ
FROM pg_stat_activity
WHERE datname = current_database()
  AND state <> 'idle'
  AND query_start IS NOT NULL
ORDER BY query_start
LIMIT 20;
