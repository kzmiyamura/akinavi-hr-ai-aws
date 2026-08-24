-- 「18名」の便から20人登録された件の内訳（2026-08-17）
-- 幽霊レコード（名簿誤検出）が混じっていないかを、属性の埋まり具合で見る。
SELECT c.name,
       coalesce(c.raw_profile->>'nearestStation', '-') AS 駅,
       coalesce(c.raw_profile->>'age', '-') AS 年齢,
       coalesce(c.desired_rate, '-') AS 単価,
       jsonb_array_length(coalesce(c.skills, '[]'::jsonb))::text AS スキル数,
       length(coalesce(c.raw_profile->>'summary', ''))::text AS 所見文字数
FROM candidates c
WHERE c.data_env='prod' AND c.merged_into IS NULL
  AND c.raw_profile->>'subject' LIKE '%常駐いけます%'
  AND c.created_at > '2026-08-17'
ORDER BY jsonb_array_length(coalesce(c.skills, '[]'::jsonb)), c.name;
