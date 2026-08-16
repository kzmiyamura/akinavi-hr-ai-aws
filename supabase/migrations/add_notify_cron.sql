-- notify-candidates を1時間間隔で実行する（2026-08-17 にユーザー判断で 5分 → 1時間）。
--
-- ⚠ 2026-08-17 まで、このファイルは YOUR_PROJECT_REF のままのテンプレートで
--    **一度も適用されていなかった**。そのため通知機能は 7/23 のデプロイ以降
--    一度も動いておらず、notification_log は0件・notify_last_checked_at も空だった。
--    cron.job に notify 系のジョブが存在しないことを実測で確認済み。
--
-- 実際の適用は scripts/sql/apply_notify_cron.sql で行う（プレースホルダを埋めた版）。
-- 関数側の探索窓は「前回実行時刻から・上限24時間」（index.ts の MAX_LOOKBACK_MS）なので、
-- 間隔を1時間に延ばしても取りこぼしはしない。
-- 間隔を変えるときは同じジョブ名で cron.schedule を再実行すれば上書きされる。

SELECT cron.schedule(
  'notify-candidates-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-candidates',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  )
  $$
);
