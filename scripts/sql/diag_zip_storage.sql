-- ZIP本体が storage に残っているかを確認する（2026-08-17）
-- 残っていれば再解析で中身を読める。残っていなければ元メールの再取得が必要。
SELECT 'attachments バケットの総オブジェクト数' AS 指標, count(*)::text AS 値
FROM storage.objects WHERE bucket_id = 'attachments'
UNION ALL
SELECT '  .zip のオブジェクト数', count(*)::text
FROM storage.objects WHERE bucket_id = 'attachments' AND name ILIKE '%.zip'
UNION ALL
SELECT '  ZIP由来の名前（コロン付き）のオブジェクト数', count(*)::text
FROM storage.objects WHERE bucket_id = 'attachments' AND name LIKE '%:%'
UNION ALL
SELECT '  最新オブジェクトの作成日時', coalesce(max(created_at)::text, '-')
FROM storage.objects WHERE bucket_id = 'attachments';
