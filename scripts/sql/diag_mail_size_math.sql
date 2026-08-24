-- 1メールあたりのサイズと、30日ぶんの見積り（2026-08-19）
-- 受信そのもの（Graph→Edge→DB）と、画面が読む量は別物なので分けて測る。
SELECT '直近7日の取り込み人材数（1日あたり）' AS 指標,
       round(count(*) / 7.0)::text AS 値
FROM candidates WHERE data_env='prod' AND created_at > now() - interval '7 days'
UNION ALL
SELECT '直近7日の ai_logs 件数（1日あたり・メール処理の回数）',
       round(count(*) / 7.0)::text
FROM ai_logs WHERE created_at > now() - interval '7 days'
UNION ALL
SELECT '人材1件の DB サイズ平均（raw_profile 込み・KB）',
       round(avg(pg_column_size(c.*)) / 1024.0, 1)::text
FROM candidates c WHERE data_env='prod'
UNION ALL
SELECT '  うち raw_profile（KB）',
       round(avg(pg_column_size(raw_profile)) / 1024.0, 1)::text
FROM candidates WHERE data_env='prod'
UNION ALL
SELECT '  うち本文 text（KB）',
       round(avg(length(raw_profile->>'text')) / 1024.0, 1)::text
FROM candidates WHERE data_env='prod'
UNION ALL
SELECT '一覧1件ぶんの転送量（raw_profile 抜き・JSON・KB）',
       round((SELECT octet_length(json_agg(t)::text) FROM (
         SELECT id, name, skills, experience_years, desired_rate, from_company,
                resume_url, created_at
         FROM candidates WHERE data_env='prod' LIMIT 100) t) / 100 / 1024.0, 2)::text
UNION ALL
SELECT 'DB 全体の candidates サイズ（MB）',
       round(pg_total_relation_size('candidates') / 1024.0 / 1024.0)::text;
