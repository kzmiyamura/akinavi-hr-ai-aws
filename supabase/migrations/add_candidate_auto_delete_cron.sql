-- 人材データ自動削除 pg_cron ジョブ（保持日数は app_config で設定可能）
-- 実行: Supabase SQL Editor で1回だけ実行すること

-- pg_cron が未有効化の場合
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

-- app_config に保持日数のデフォルト値を登録（既存値は上書きしない）
INSERT INTO app_config (key, value)
VALUES ('candidate_retention_days', '7')
ON CONFLICT (key) DO NOTHING;

-- 保持日数を参照して削除する PostgreSQL 関数
CREATE OR REPLACE FUNCTION delete_old_candidates()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  retention_days integer;
BEGIN
  -- app_config から保持日数を取得（未設定時は 7 日）
  SELECT COALESCE(value::integer, 7)
  INTO retention_days
  FROM app_config
  WHERE key = 'candidate_retention_days';

  IF retention_days IS NULL THEN
    retention_days := 7;
  END IF;

  -- submissions を先に削除（FK 制約）
  DELETE FROM submissions
  WHERE candidate_id IN (
    SELECT id FROM candidates
    WHERE created_at < NOW() - (retention_days || ' days')::interval
  );

  -- 人材を削除
  DELETE FROM candidates
  WHERE created_at < NOW() - (retention_days || ' days')::interval;
END;
$$;

-- 既存ジョブがあれば削除して再登録
SELECT cron.unschedule('delete-old-candidates')
FROM cron.job
WHERE jobname = 'delete-old-candidates';

-- 毎日 JST 0:00（UTC 15:00）に実行
SELECT cron.schedule(
  'delete-old-candidates',
  '0 15 * * *',
  'SELECT delete_old_candidates()'
);
