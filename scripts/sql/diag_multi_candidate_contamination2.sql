-- 複数人材メール「全体」での混入チェック（2026-08-17・6000字超に限らない）
WITH multi_keys AS (
  SELECT md5(raw_profile->>'text') AS mail_key
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL AND raw_profile->>'text' IS NOT NULL
  GROUP BY 1 HAVING count(*) >= 2
),
people AS (
  SELECT c.id, c.name
  FROM candidates c
  WHERE c.data_env='prod' AND c.merged_into IS NULL
    AND md5(c.raw_profile->>'text') IN (SELECT mail_key FROM multi_keys)
),
logs AS (
  SELECT s.candidate_id, s.body_fields, jsonb_array_length(s.body_fields) AS n
  FROM llm_shadow s
  WHERE s.source='body' AND s.body_fields IS NOT NULL
    AND s.candidate_id IN (SELECT id FROM people)
)
SELECT '複数人材メールの人材（prod）' AS 指標, count(*)::text AS 値 FROM people
UNION ALL SELECT '  本文AIのログあり', count(*)::text FROM logs
UNION ALL SELECT '  AIが1人だけ返した回', count(*)::text FROM logs WHERE n = 1
UNION ALL SELECT '  ★そのうち名前が本人と違う（別人の値を適用した疑い）',
  count(*)::text FROM logs l JOIN people p ON p.id = l.candidate_id
  WHERE l.n = 1
    AND replace(replace(lower(coalesce(l.body_fields->0->>'name','')), '.', ''), ' ', '')
        <> replace(replace(lower(p.name), '.', ''), ' ', '')
UNION ALL SELECT '  AIが2人以上返した回（名前照合が働く＝安全）', count(*)::text FROM logs WHERE n > 1;
