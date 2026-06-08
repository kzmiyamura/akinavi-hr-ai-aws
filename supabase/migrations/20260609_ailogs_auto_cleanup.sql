-- ai_logs 自動削除 cron
-- 86MB まで膨らんだ ai_logs を 30 日以上経過したレコードから毎日削除する。
-- 実行: 毎日 UTC 17:00（JST 2:00）に起動
--
-- 実行前に書き換えてください:
--   YOUR_SERVICE_ROLE_KEY → Supabase Dashboard → Project Settings → API → service_role key

SELECT cron.unschedule('ailogs-cleanup-daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ailogs-cleanup-daily');

SELECT cron.schedule(
  'ailogs-cleanup-daily',
  '0 17 * * *',
  $$
  DELETE FROM public.ai_logs WHERE created_at < NOW() - INTERVAL '30 days';
  $$
);

SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'ailogs-cleanup-daily';
