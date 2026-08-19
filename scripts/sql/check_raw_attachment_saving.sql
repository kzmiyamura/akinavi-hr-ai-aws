-- 受信添付の実体が「必ず」保存されているかを確認する（2026-08-20）
--
-- 9fd2468 で saveRawAttachments を追加した（割り当て成否と無関係に raw/<msgId>/ へ保存）。
-- 台帳（ai_logs type='poll-attach'）に記録された添付の数と、
-- Storage に実際に落ちている数を突き合わせる。
SELECT '台帳の添付ログ（8/19以降）' AS 指標, count(*)::text AS 値
FROM ai_logs WHERE type='poll-attach' AND created_at >= '2026-08-19'
UNION ALL
SELECT '  うち添付1件以上を記録', count(*)::text
FROM ai_logs WHERE type='poll-attach' AND created_at >= '2026-08-19'
  AND ai_result->'manifest' IS NOT NULL
  AND jsonb_array_length(ai_result->'manifest') > 0
UNION ALL
SELECT 'Storage raw/ 配下のファイル数', count(*)::text
FROM storage.objects WHERE bucket_id='attachments' AND name LIKE 'raw/%'
UNION ALL
SELECT '  うち直近24時間', count(*)::text
FROM storage.objects WHERE bucket_id='attachments' AND name LIKE 'raw/%'
  AND created_at > now() - interval '24 hours'
UNION ALL
SELECT '  最新の保存時刻', coalesce(max(created_at)::text, '(なし)')
FROM storage.objects WHERE bucket_id='attachments' AND name LIKE 'raw/%'
UNION ALL
SELECT '  合計サイズ(MB)', coalesce(round(sum((metadata->>'size')::bigint)/1024.0/1024.0, 1)::text, '0')
FROM storage.objects WHERE bucket_id='attachments' AND name LIKE 'raw/%'
UNION ALL
SELECT '（参考）resumes/ など従来分', count(*)::text
FROM storage.objects WHERE bucket_id='attachments' AND name NOT LIKE 'raw/%';
