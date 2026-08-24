-- cron が生きているか・タイムゾーンはどれかを確認する（2026-08-17）
-- notify-candidates-hourly を登録したのに実行されないため、
-- 同じ「毎時」の既存ジョブ（hf-spaces-keepalive）と比べる。
SELECT now()::text AS db現在時刻,
       current_setting('TimeZone') AS dbタイムゾーン;

SELECT j.jobname, j.schedule, j.active::text AS active,
       max(r.start_time)::text AS 最終開始,
       count(r.runid) FILTER (WHERE r.start_time > now() - interval '2 hours')::text AS 実行_直近2h
FROM cron.job j
LEFT JOIN cron.job_run_details r ON r.jobid = j.jobid
WHERE j.jobname IN ('hf-spaces-keepalive', 'poll-email-every-5-minutes', 'notify-candidates-hourly')
GROUP BY j.jobname, j.schedule, j.active
ORDER BY j.jobname;
