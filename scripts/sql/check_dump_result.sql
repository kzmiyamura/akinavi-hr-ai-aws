-- 添付ダンプの結果を確認する（2026-08-19）
-- dump_attachments_by_query.sql 実行後、次のポーリングで救出されたかを見る。
SELECT 'ダンプ結果のログ件数' AS 指標, count(*)::text AS 値
FROM ai_logs WHERE type = 'dump-attach'
UNION ALL
SELECT '  直近1時間', count(*)::text
FROM ai_logs WHERE type = 'dump-attach' AND created_at > now() - interval '1 hour'
UNION ALL
SELECT '  最新の内容', coalesce(left((SELECT ai_result::text FROM ai_logs
  WHERE type='dump-attach' ORDER BY created_at DESC LIMIT 1), 300), '(まだ無し)')
UNION ALL
SELECT '現在の poll モード', (SELECT value::text FROM app_config WHERE key='email_poll_mode')
UNION ALL
SELECT 'Storage の dump/ 配下', count(*)::text
FROM storage.objects WHERE bucket_id = 'attachments' AND name LIKE 'dump/%'
UNION ALL
SELECT '直近のポーリング成功', coalesce((SELECT max(created_at)::text FROM ai_logs
  WHERE type IN ('candidate','poll-attach')), '(なし)');
