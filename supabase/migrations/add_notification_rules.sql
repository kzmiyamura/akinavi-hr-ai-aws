-- 通知ルール: 指定した条件（名前・スキル・最寄駅）の人材が現れたらメール通知する
-- UI: 「通知」タブ（NotificationsPage）で追加・編集・削除
-- 送信: notify-candidates Edge Function（pg_cron 5分間隔・add_notify_cron.sql で登録）

CREATE TABLE IF NOT EXISTS notification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL DEFAULT '',
  -- 条件（いずれか1つ以上を指定。指定した条件はすべて満たす必要がある=AND）
  name_keyword text NOT NULL DEFAULT '',      -- 人材名/イニシャルの部分一致（正規化: 記号・空白無視）
  skill_keywords text[] NOT NULL DEFAULT '{}', -- 全キーワードがスキルに含まれること（AND）
  station_keyword text NOT NULL DEFAULT '',   -- 最寄駅/都道府県の部分一致
  notify_email text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  data_env text NOT NULL DEFAULT 'prod' CHECK (data_env IN ('prod', 'demo')),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 送信済み記録（同じルール×人材への二重通知防止）
-- candidate_id は FK にしない: 人材はアーカイブ・削除されるが通知履歴は残す
CREATE TABLE IF NOT EXISTS notification_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  candidate_name text NOT NULL DEFAULT '',
  sent_to text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, candidate_id)
);

-- 通知チェックの状態管理
INSERT INTO app_config (key, value) VALUES ('notify_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_config (key, value) VALUES ('notify_last_checked_at', '')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_config (key, value) VALUES ('notify_last_error', '')
  ON CONFLICT (key) DO NOTHING;
