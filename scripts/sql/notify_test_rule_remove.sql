-- テスト送信用の一時ルールを削除する（2026-08-18）
-- notification_log は ON DELETE CASCADE なので、このルールぶんの送信済み記録も消える。
-- 既存ルール（大阪人材）とその履歴には影響しない。
BEGIN;
DELETE FROM notification_rules WHERE created_by = 'claude-test';
COMMIT;

SELECT '残っているテストルール' AS 指標, count(*)::text AS 値
FROM notification_rules WHERE created_by = 'claude-test'
UNION ALL
SELECT '通知ルールの総数', count(*)::text FROM notification_rules
UNION ALL
SELECT '通知ログの総数', count(*)::text FROM notification_log;
