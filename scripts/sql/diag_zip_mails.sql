-- ZIP添付で届いた人材が、どのメールに何人ずつ入っているかを一覧する（2026-08-17）
-- 再取得（Graph からの取り直し）の対象を決めるため。
SELECT c.raw_profile->>'from' AS 送信元,
       left(c.raw_profile->>'subject', 40) AS 件名,
       count(*)::text AS 人数,
       count(*) FILTER (WHERE c.resume_url IS NULL)::text AS 経歴書なし,
       min(c.created_at)::date::text AS 取込日,
       left(c.raw_profile->>'attachmentNames', 60) AS 添付名
FROM candidates c
WHERE c.data_env = 'prod' AND c.merged_into IS NULL
  AND c.raw_profile::text ILIKE '%.zip%'
GROUP BY 1, 2, 6
ORDER BY 取込日 DESC, 人数 DESC
LIMIT 40;
