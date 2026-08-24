-- 同名別人の分割が過剰でないかを見る（2026-08-17）
-- 件名は「18名」なのに20人登録された 8/17 のフォスターネット便を調べる。
-- 判定材料（駅・県・年齢・単価）が本当に食い違っているのかを並べる。
SELECT c.name,
       coalesce(c.raw_profile->>'nearestStation', '-') AS 駅,
       coalesce(c.raw_profile->>'prefecture', '-') AS 県,
       coalesce(c.raw_profile->>'age', '-') AS 年齢,
       coalesce(c.desired_rate, '-') AS 単価,
       coalesce(c.experience_years::text, '-') AS 経験年数,
       jsonb_array_length(coalesce(c.skills, '[]'::jsonb))::text AS スキル数,
       c.created_at::time(0)::text AS 登録時刻
FROM candidates c
WHERE c.data_env='prod' AND c.merged_into IS NULL
  AND c.raw_profile->>'subject' LIKE '%常駐いけます%'
  AND c.created_at > '2026-08-17'
  AND c.name IN (
    SELECT name FROM candidates
    WHERE data_env='prod' AND merged_into IS NULL
      AND raw_profile->>'subject' LIKE '%常駐いけます%' AND created_at > '2026-08-17'
    GROUP BY name HAVING count(*) >= 2)
ORDER BY c.name, c.created_at;
