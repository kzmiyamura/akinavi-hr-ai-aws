-- cleanup-storage cron: 毎日 JST 1:00 (UTC 16:00) に Storage の古いファイルを削除
-- Issue #61: Supabase Storage 無料枠超過対策
--
-- 実行前に以下の ★ 箇所を実際の値に書き換えること
--   YOUR_PROJECT_REF      → Supabase Dashboard → Project Settings → General → Reference ID
--   YOUR_SERVICE_ROLE_KEY → Supabase Dashboard → Project Settings → API → service_role key

SELECT cron.unschedule('cleanup-storage-daily')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'cleanup-storage-daily'
  );

-- 毎日 UTC 16:00（JST 1:00）に cleanup-storage を起動
SELECT cron.schedule(
  'cleanup-storage-daily',
  '0 16 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/cleanup-storage',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'cleanup-storage-daily';
