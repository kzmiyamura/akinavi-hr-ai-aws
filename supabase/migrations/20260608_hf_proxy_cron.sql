-- HF Spaces 品質チェックを Edge Function (hf-proxy) 経由で呼び出す
-- pg_net から HF Spaces への直接アクセスが HF 側でブロックされるため、
-- Deno Deploy (Edge Function) を中継として使う
--
-- 実行前に書き換えてください:
--   YOUR_SERVICE_ROLE_KEY → Supabase Dashboard → Project Settings → API → service_role key

-- 既存スケジュールを削除
SELECT cron.unschedule('hf-spaces-quality-check')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hf-spaces-quality-check');

SELECT cron.unschedule('hf-spaces-keepalive')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hf-spaces-keepalive');

-- 毎晩 JST 3:00（UTC 18:00）に品質チェックを実行
SELECT cron.schedule(
  'hf-spaces-quality-check',
  '0 18 * * *',
  $$
  SELECT net.http_get(
    url     := 'https://argizomylbolpqxgmvim.supabase.co/functions/v1/hf-proxy?path=/run_quality_check',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

-- キープアライブ: 毎時 0分 に /health を呼んでスリープを防ぐ
SELECT cron.schedule(
  'hf-spaces-keepalive',
  '0 * * * *',
  $$
  SELECT net.http_get(
    url     := 'https://argizomylbolpqxgmvim.supabase.co/functions/v1/hf-proxy?path=/health',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);

-- 確認
SELECT jobname, schedule FROM cron.job
WHERE jobname IN ('hf-spaces-quality-check', 'hf-spaces-keepalive');
