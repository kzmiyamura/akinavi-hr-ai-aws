-- notify-candidates を5分間隔で実行（poll-email と同じ間隔・実行後に走る想定で2分ずらし）
-- 実行前に YOUR_PROJECT_REF と YOUR_SERVICE_ROLE_KEY を書き換えること

SELECT cron.schedule(
  'notify-candidates-5min',
  '2-59/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-candidates',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  )
  $$
);
