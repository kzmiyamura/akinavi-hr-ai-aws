-- ポーリングが今も動いているかを確認する（2026-08-19）
-- 添付ダンプが走らないため、そもそも poll-email が回っているかを見る。
SELECT 'DB現在時刻(UTC)' AS 指標, now()::text AS 値
UNION ALL
SELECT 'poll-email cron の直近5回',
       string_agg(to_char(start_time, 'HH24:MI:SS'), ' / ' ORDER BY start_time DESC)
FROM (SELECT r.start_time FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
      WHERE j.jobname = 'poll-email-every-5-minutes' ORDER BY r.start_time DESC LIMIT 5) x
UNION ALL
SELECT '  うち失敗',
       count(*)::text FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
 WHERE j.jobname = 'poll-email-every-5-minutes' AND r.start_time > now() - interval '30 minutes'
   AND r.status <> 'succeeded'
UNION ALL
SELECT 'ai_logs の直近30分の件数', count(*)::text
FROM ai_logs WHERE created_at > now() - interval '30 minutes'
UNION ALL
SELECT '  種別の内訳', coalesce(string_agg(DISTINCT type || ':' || cnt::text, ' / '), '(なし)')
FROM (SELECT type, count(*) AS cnt FROM ai_logs
      WHERE created_at > now() - interval '30 minutes' GROUP BY type) y
UNION ALL
SELECT 'email_dump_query', (SELECT value::text FROM app_config WHERE key='email_dump_query');
