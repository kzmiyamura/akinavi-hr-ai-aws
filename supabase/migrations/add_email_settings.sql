-- メール設定のデフォルト値を app_config に追加
-- 既存レコードがある場合は上書きしない（ON CONFLICT DO NOTHING）

INSERT INTO app_config (key, value) VALUES
  ('email_human_address',          '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value) VALUES
  ('email_project_address',        '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value) VALUES
  ('email_use_ai_classification',  'false')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value) VALUES
  ('email_poll_mode',              'incremental')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value) VALUES
  ('email_full_import_since',      '')
ON CONFLICT (key) DO NOTHING;
