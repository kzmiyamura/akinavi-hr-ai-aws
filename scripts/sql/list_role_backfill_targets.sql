-- 役割バックフィルの対象 id を出す（2026-08-17）
-- 条件: 本文に営業定型文があり、役割が1つ以上ついていて、**単独メール**由来。
-- 複数人材メールは raw_profile.text がメール全文なので再計算すると悪化するため外す。
WITH grp AS (
  SELECT md5(raw_profile->>'text') AS k, count(*) AS n
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL AND raw_profile->>'text' IS NOT NULL
  GROUP BY 1
)
SELECT json_agg(c.id)::text AS ids
FROM candidates c
JOIN grp g ON g.k = md5(c.raw_profile->>'text')
WHERE c.data_env='prod' AND c.merged_into IS NULL
  AND g.n = 1
  AND c.raw_profile->>'text' ~ '(要員|人材|エンジニア|技術者)\s*以外にも|他にも多数'
  AND jsonb_array_length(coalesce(c.raw_profile->'roles','[]'::jsonb)) > 0;
