-- verify-agent-license を毎日 JST 2:00（UTC 17:00）に実行
-- 実行前に YOUR_PROJECT_REF と YOUR_SERVICE_ROLE_KEY を書き換えること

SELECT cron.schedule(
  'verify-agent-license-daily',
  '0 17 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/verify-agent-license',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{"batch_size":20}'::jsonb
  )
  $$
);
