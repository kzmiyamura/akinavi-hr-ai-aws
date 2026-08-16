-- notify-candidates の cron が登録・稼働しているかを確認する（2026-08-17）
-- notify_last_checked_at が空だったため、「ルールが合致しない」以前に
-- 関数が呼ばれているのかを切り分ける。
-- 参考: 全 cron ジョブを出して notify 系の有無を目で確認できるようにしている。
SELECT j.jobid::text AS jobid,
       j.jobname,
       j.schedule,
       j.active::text AS active,
       left(j.command, 60) AS command_head,
       coalesce(count(r.runid) FILTER (WHERE r.start_time > now() - interval '24 hours'), 0)::text AS 実行_24h,
       coalesce(count(r.runid) FILTER (WHERE r.start_time > now() - interval '24 hours'
                                         AND r.status <> 'succeeded'), 0)::text AS 失敗_24h,
       coalesce(max(r.end_time)::text, '(実行記録なし)') AS 最終実行
FROM cron.job j
LEFT JOIN cron.job_run_details r ON r.jobid = j.jobid
GROUP BY j.jobid, j.jobname, j.schedule, j.active, j.command
ORDER BY j.jobname;
