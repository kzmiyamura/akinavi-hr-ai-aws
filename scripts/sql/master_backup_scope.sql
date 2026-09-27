-- Free 移行前に「控えが無い＝失うと作り直せない表」を洗い出す（2026-09-28）
-- 本体は返さない。件数と転送見込みだけ。
SELECT 'skill_master' AS 表, count(*)::text AS 行数,
       pg_size_pretty(octet_length(json_agg(t)::text)::bigint) AS 転送見込み, 1 AS ord
FROM (SELECT * FROM skill_master) t
UNION ALL SELECT 'station_master', count(*)::text, pg_size_pretty(octet_length(json_agg(t)::text)::bigint), 2
FROM (SELECT * FROM station_master) t
UNION ALL SELECT 'skill_implications', count(*)::text, pg_size_pretty(octet_length(json_agg(t)::text)::bigint), 3
FROM (SELECT * FROM skill_implications) t
UNION ALL SELECT 'notification_rules', count(*)::text, pg_size_pretty(octet_length(json_agg(t)::text)::bigint), 4
FROM (SELECT * FROM notification_rules) t
UNION ALL SELECT 'app_config', count(*)::text, pg_size_pretty(octet_length(json_agg(t)::text)::bigint), 5
FROM (SELECT * FROM app_config) t
UNION ALL SELECT 'candidates_archive_light', count(*)::text, pg_size_pretty(octet_length(json_agg(t)::text)::bigint), 6
FROM (SELECT * FROM candidates_archive_light) t
UNION ALL SELECT 'submissions', count(*)::text, pg_size_pretty(octet_length(json_agg(t)::text)::bigint), 7
FROM (SELECT * FROM submissions) t
ORDER BY 4;
