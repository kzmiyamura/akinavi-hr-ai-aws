-- 救出対象メールの実際の件名を台帳から確認する（2026-08-19）
-- ダンプが matched=0 だったため、検索文字列（【直人材のご紹介】Java）が
-- 実際の件名と一致していない可能性を確かめる。
SELECT created_at::text AS 受信,
       left(coalesce(subject, '(件名なし)'), 70) AS 件名,
       coalesce(from_address, '-') AS 送信元,
       left(ai_result::text, 200) AS 内容
FROM ai_logs
WHERE type = 'poll-attach'
  AND ai_result::text ILIKE '%アイスタンダード%'
ORDER BY created_at DESC
LIMIT 5;
