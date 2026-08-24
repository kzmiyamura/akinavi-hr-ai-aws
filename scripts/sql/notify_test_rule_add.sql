-- 通知メールのテスト送信用に、一時ルールを1件だけ作る（2026-08-18）
-- 目的: 差出人の表示名を変更した効果を確認する。
--
-- 後片付け: scripts/sql/notify_test_rule_remove.sql を必ず実行すること。
-- notification_log.rule_id は ON DELETE CASCADE なので、ルールを消せば
-- このテストで作られた送信済み記録も一緒に消える（既存の通知履歴には触らない）。
BEGIN;

INSERT INTO notification_rules (label, skill_keywords, notify_email, data_env, created_by)
VALUES ('__テスト送信（自動削除予定）__', ARRAY['Java'], 'kzmiyamura@gmail.com', 'prod', 'claude-test');

-- 探索窓を24時間に戻す（直前の手動実行で「今」まで進んでいるため、このままだと対象0件）
UPDATE app_config SET value = '""'::json WHERE key = 'notify_last_checked_at';

COMMIT;

SELECT label, notify_email, skill_keywords::text AS skills FROM notification_rules WHERE created_by = 'claude-test';
