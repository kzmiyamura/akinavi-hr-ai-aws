-- notify-candidates の実行結果を確認する（2026-08-17 の cron 登録後の検証用）
SELECT 'cronの実行回数（直近3時間）' AS 指標,
       count(*)::text AS 値
FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname = 'notify-candidates-hourly' AND r.start_time > now() - interval '3 hours'
UNION ALL
SELECT '  うち失敗', count(*)::text
FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname = 'notify-candidates-hourly' AND r.start_time > now() - interval '3 hours'
  AND r.status <> 'succeeded'
UNION ALL
SELECT '  最終実行', coalesce(max(r.end_time)::text, '(まだ)')
FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname = 'notify-candidates-hourly'
UNION ALL
SELECT 'notify_last_checked_at', coalesce(nullif(value::text, ''), '(空)')
FROM app_config WHERE key = 'notify_last_checked_at'
UNION ALL
SELECT 'notify_last_error', coalesce(nullif(left(value::text, 200), ''), '(なし)')
FROM app_config WHERE key = 'notify_last_error'
UNION ALL
SELECT '通知ログ累計', count(*)::text FROM notification_log
UNION ALL
SELECT '通知ログ（直近3時間）', count(*)::text FROM notification_log
WHERE sent_at > now() - interval '3 hours';
