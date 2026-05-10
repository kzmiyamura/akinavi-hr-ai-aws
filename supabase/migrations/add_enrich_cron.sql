-- enrich-candidate Edge Function を毎日 JST 3:00（UTC 18:00）に実行する pg_cron スケジュール
-- ※ box-downloader バッチの完了後に走るよう時刻を設定（box-downloaderは夜間に実行する想定）
--
-- 実行前に以下を書き換えること:
--   YOUR_PROJECT_REF  → Supabase プロジェクトの参照ID（例: argizomylbolpqxgmvim）
--   YOUR_SERVICE_ROLE_KEY → Supabase の service_role キー

-- pg_cron / pg_net の有効化（既に有効な場合はスキップ）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 既存スケジュールがあれば削除してから登録（べき等）
select cron.unschedule('enrich-candidate-daily') where exists (
  select 1 from cron.job where jobname = 'enrich-candidate-daily'
);

select cron.schedule(
  'enrich-candidate-daily',
  '0 18 * * *',  -- UTC 18:00 = JST 3:00（box-downloader バッチ完了後）
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/enrich-candidate',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
