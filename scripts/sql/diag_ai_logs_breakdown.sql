-- ai_logs の内訳（2026-08-19）
-- 「1日1,970件処理して人材登録は258人」の差が何なのかを分解する。
SELECT type AS 種別, status AS 状態, count(*)::text AS 件数,
       round(count(*) / 7.0)::text AS 日あたり
FROM ai_logs
WHERE created_at > now() - interval '7 days'
GROUP BY type, status
ORDER BY count(*) DESC
LIMIT 20;
