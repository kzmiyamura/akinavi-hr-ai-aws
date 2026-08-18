-- raw_profile にどんなキーがあるかを数える（値は返さない・2026-08-17）
-- 添付テキストが保存されていれば、役割の再計算を添付込みで正しくやり直せる。
SELECT k AS キー, count(*)::text AS 件数
FROM candidates c, LATERAL jsonb_object_keys(c.raw_profile) k
WHERE c.data_env='prod' AND c.merged_into IS NULL
GROUP BY k
ORDER BY count(*) DESC
LIMIT 60;
