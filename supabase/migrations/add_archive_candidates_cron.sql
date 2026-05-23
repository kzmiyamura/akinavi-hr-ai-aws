-- Migration: 人材データアーカイブ用 pg_cron スケジュール設定
-- 7日以上経過した prod 人材を Supabase Storage に JSONL アーカイブしてから DB 削除する。
-- 旧 delete-old-candidates（DB直接削除）を廃止し archive-candidates Edge Function に切り替える。
--
-- 実行前に以下の ★ 箇所を実際の値に書き換えること
--   YOUR_PROJECT_REF      → Supabase Dashboard → Project Settings → General → Reference ID
--   YOUR_SERVICE_ROLE_KEY → Supabase Dashboard → Project Settings → API → service_role key

-- ① 旧スケジュール（DB直接削除）を廃止
SELECT cron.unschedule('delete-old-candidates')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'delete-old-candidates'
  );

-- ② 新スケジュール（アーカイブ → 削除）を登録
--    既存があれば削除してから再登録（冪等）
SELECT cron.unschedule('archive-candidates-daily')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'archive-candidates-daily'
  );

-- 毎日 0:00 UTC（日本時間 9:00）に archive-candidates を起動
SELECT cron.schedule(
  'archive-candidates-daily',
  '0 15 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/archive-candidates',
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
WHERE jobname IN ('archive-candidates-daily', 'delete-old-candidates');
