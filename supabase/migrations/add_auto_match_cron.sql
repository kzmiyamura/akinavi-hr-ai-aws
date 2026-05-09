-- Migration: 自動マッチング用 pg_cron スケジュール設定
-- 毎朝 9:00 JST（= 0:00 UTC）に auto-match Edge Function を呼び出す
-- 直近25時間に登録された案件と候補者を自動マッチングする
--
-- 実行前に以下の ★ 箇所を実際の値に書き換えること
--   YOUR_PROJECT_REF     → Supabase Dashboard → Project Settings → General → Reference ID
--   YOUR_SERVICE_ROLE_KEY → Supabase Dashboard → Project Settings → API → service_role key

-- 既存スケジュールを削除（再実行時の冪等性）
SELECT cron.unschedule('auto-match-daily')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'auto-match-daily'
  );

-- 毎日 0:00 UTC（日本時間 9:00）に auto-match を起動
SELECT cron.schedule(
  'auto-match-daily',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/auto-match',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- 登録確認
SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'auto-match-daily';
