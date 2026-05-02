-- Migration: Outlook メールポーリング用 pg_cron スケジュール設定
-- 実行前に以下を確認:
--   1. pg_cron, pg_net 拡張が有効になっていること
--      Supabase Dashboard → Database → Extensions → pg_cron / pg_net をON
--   2. 以下の ★ 箇所を実際の値に書き換えること
--      YOUR_PROJECT_REF → Supabase Dashboard → Project Settings → General → Reference ID
--      YOUR_SERVICE_ROLE_KEY → Supabase Dashboard → Project Settings → API → service_role key

-- ① 拡張機能の有効化（既に有効な場合はスキップ）
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ② app_config テーブルに key カラムの UNIQUE 制約がなければ追加
--    （リフレッシュトークンのローテーション保存用）
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS value text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_config_key_unique'
  ) THEN
    ALTER TABLE app_config ADD CONSTRAINT app_config_key_unique UNIQUE (key);
  END IF;
END $$;

-- ③ 既存スケジュールを削除（再実行時の冪等性）
SELECT cron.unschedule('poll-email-every-5-minutes')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'poll-email-every-5-minutes'
  );

-- ④ 5分ごとに poll-email Edge Function を呼び出すスケジュール登録
--    ★ YOUR_PROJECT_REF と YOUR_SERVICE_ROLE_KEY を書き換えてから実行すること
SELECT cron.schedule(
  'poll-email-every-5-minutes',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- ⑤ 登録確認
SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'poll-email-every-5-minutes';
