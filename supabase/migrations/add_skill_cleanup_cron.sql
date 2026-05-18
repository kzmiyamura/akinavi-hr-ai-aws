-- skill-master-cleanup を毎日 JST 3:00（UTC 18:00）に実行
-- 実行前に YOUR_PROJECT_REF と YOUR_SERVICE_ROLE_KEY を書き換えること

SELECT cron.schedule(
  'skill-master-cleanup-daily',
  '0 18 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/skill-master-cleanup',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  )
  $$
);
