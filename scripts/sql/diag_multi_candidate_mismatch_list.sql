-- 「AIが1人だけ返し、その名前がDBの人材名と違う」18件の中身を見る（2026-08-17）
-- 別人混入なのか、添付から実名を取ったケース（正常）なのかを人の目で判定するため。
WITH multi_keys AS (
  SELECT md5(raw_profile->>'text') AS mail_key
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL AND raw_profile->>'text' IS NOT NULL
  GROUP BY 1 HAVING count(*) >= 2
),
people AS (
  SELECT c.id, c.name, md5(c.raw_profile->>'text') AS mail_key,
         c.raw_profile->>'_llm_applied' AS applied,
         c.raw_profile->>'nearestStation' AS station,
         c.raw_profile->>'age' AS age
  FROM candidates c
  WHERE c.data_env='prod' AND c.merged_into IS NULL
    AND md5(c.raw_profile->>'text') IN (SELECT mail_key FROM multi_keys)
)
SELECT p.name AS db名,
       l.body_fields->0->>'name' AS ai名,
       l.body_fields->0->>'age' AS ai年齢,
       left(coalesce(l.body_fields->0->>'station',''), 20) AS ai駅,
       left(coalesce(p.applied, ''), 120) AS 適用記録,
       (SELECT count(*) FROM people q WHERE q.mail_key = p.mail_key)::text AS 同一メール人数
FROM llm_shadow l JOIN people p ON p.id = l.candidate_id
WHERE l.source='body' AND l.body_fields IS NOT NULL
  AND jsonb_array_length(l.body_fields) = 1
  AND replace(replace(lower(coalesce(l.body_fields->0->>'name','')), '.', ''), ' ', '')
      <> replace(replace(lower(p.name), '.', ''), ' ', '')
ORDER BY 同一メール人数 DESC, p.name
LIMIT 20;
