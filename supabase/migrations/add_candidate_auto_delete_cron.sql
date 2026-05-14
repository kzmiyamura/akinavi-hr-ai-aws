-- 人材データ7日自動削除 pg_cron ジョブ
-- submissionsはcandidate_idへのFK参照があるため先に削除
-- 実行: Supabase SQL Editor で1回だけ実行すること

-- pg_cron / pg_net が未有効化の場合
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 既存ジョブがあれば削除
SELECT cron.unschedule('delete-old-candidates') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'delete-old-candidates'
);

-- 毎日 JST 0:00（UTC 15:00）に7日以上前の人材データを削除
SELECT cron.schedule(
  'delete-old-candidates',
  '0 15 * * *',
  $$
  DELETE FROM submissions
  WHERE candidate_id IN (
    SELECT id FROM candidates
    WHERE created_at < NOW() - INTERVAL '7 days'
  );

  DELETE FROM candidates
  WHERE created_at < NOW() - INTERVAL '7 days';
  $$
);
