-- 添付ダンプのログ全文（2026-08-19）
-- どのフォルダを何件走査したかを切らずに見る（recoverableitemsdeletions まで到達したか）。
SELECT created_at::time(0)::text AS 時刻,
       coalesce(error_message, '-') AS 走査結果
FROM ai_logs
WHERE type = 'dump-attach'
ORDER BY created_at DESC
LIMIT 2;
