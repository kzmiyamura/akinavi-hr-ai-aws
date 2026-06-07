-- HF Spaces 品質チェックバッチを毎晩 JST 3:00（UTC 18:00）に起動する
-- 実行前に以下を書き換えてください:
--   YOUR_API_SECRET → HF Spaces の Secrets に設定した API_SECRET の値

-- pg_cron / pg_net が有効であること（既存の cron で有効化済みのはず）

-- 既存スケジュールがあれば削除
SELECT cron.unschedule('hf-spaces-quality-check') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'hf-spaces-quality-check'
);

-- 毎晩 JST 3:00（UTC 18:00）に品質チェックを実行
SELECT cron.schedule(
  'hf-spaces-quality-check',
  '0 18 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://kzmiyamura-akinavi-quality-check.hf.space/run_quality_check',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-api-secret',  'YOUR_API_SECRET'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

-- キープアライブ: 毎時 0分 に /health を呼んでスリープを防ぐ
-- （48時間無アクセスでスリープするため、毎時呼ぶことで回避）
SELECT cron.unschedule('hf-spaces-keepalive') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'hf-spaces-keepalive'
);

SELECT cron.schedule(
  'hf-spaces-keepalive',
  '0 * * * *',
  $$
  SELECT net.http_get(
    url     := 'https://kzmiyamura-akinavi-quality-check.hf.space/health',
    headers := jsonb_build_object('x-api-secret', 'YOUR_API_SECRET'),
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);

-- 確認
SELECT jobname, schedule, command FROM cron.job
WHERE jobname IN ('hf-spaces-quality-check', 'hf-spaces-keepalive');
