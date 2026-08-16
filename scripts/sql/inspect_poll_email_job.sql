-- poll-email ジョブの command の形を確認する（鍵は伏せる）。
-- apply_notify_cron.sql の正規表現が当たらなかったため、実際のヘッダ表記を見る。
SELECT jobname,
       regexp_replace(
         regexp_replace(command, '(ey[A-Za-z0-9_.-]{10,})', '***JWT***', 'g'),
         '\s+', ' ', 'g') AS command_masked
FROM cron.job
WHERE jobname IN ('poll-email-every-5-minutes', 'auto-match-daily');
