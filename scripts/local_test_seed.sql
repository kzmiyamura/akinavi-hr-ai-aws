-- ローカルSupabase テスト環境用シード
-- 用途: supabase start + schema.sql 適用後に1回実行する（本番には流さない）
--   psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -f scripts/local_test_seed.sql
-- 前提: supabase/schema.sql 適用済み（app_config.value は jsonb）

-- ── Storage: attachments バケット（add_attachments_bucket.sql と同等） ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('attachments', 'attachments', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  CREATE POLICY "Public read attachments"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'attachments');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Service role upload attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'attachments');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── app_config 初期値（value は jsonb のため JSON 文字列としてクォート） ──
INSERT INTO public.app_config (key, value) VALUES
  ('inbound_project_enabled', '"false"'),
  ('auto_match_enabled', '"false"'),
  ('email_poll_mode', '"incremental"'),
  ('email_classify_enabled', '"false"'),
  ('matching_run_mode', '"fast"'),
  ('candidate_retention_days', '"7"')
ON CONFLICT (key) DO NOTHING;
