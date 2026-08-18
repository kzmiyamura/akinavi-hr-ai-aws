-- 隔離された14件の中身（2026-08-19）。判定が妥当か目視するため名前と件名だけ出す。
SELECT name AS 登録名,
       coalesce(from_company, '-') AS 会社,
       left(coalesce(raw_profile->>'subject', '(件名なし)'), 45) AS 件名,
       created_at::date::text AS 登録日
FROM candidates
WHERE data_env='prod' AND raw_profile ? '_quarantine'
ORDER BY created_at DESC;
