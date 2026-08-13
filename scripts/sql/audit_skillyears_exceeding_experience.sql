-- スキル経験年数が本人の経験年数を超えている人材を数える。
--
-- スキルの年数が職歴の長さを超えることは原理的にありえない。それでも起きる
-- （2026-08-13 実害: 25歳・経験2年10ヶ月で PHP 16.3年）。経験年数と並べて画面に出るため、
-- 1件でも残っていると数字全体が信用されなくなる。
--
-- capSkillYearsByCareer は取り込み時にしか効かないので、既存分は再解析が要る。
-- ここで対象を数え、ひどい順に出す。
-- ひどい順の上位30件（再解析の優先順位づけ用）
WITH x AS (
  SELECT
    id, name, experience_years,
    (SELECT max(value::numeric)
       FROM jsonb_each_text(raw_profile->'skillYears')
      WHERE key NOT LIKE '\_%' AND value ~ '^[0-9]+$') AS max_months
  FROM candidates
  WHERE data_env = 'prod' AND merged_into IS NULL
    AND raw_profile->'skillYears' IS NOT NULL
    AND experience_years IS NOT NULL AND experience_years > 0
)
SELECT id, name, experience_years AS 経験年,
       round(max_months / 12.0, 1) AS スキル最長年,
       round((max_months / 12.0) - experience_years, 1) AS 超過年
FROM x
WHERE max_months > (experience_years + 1) * 12
ORDER BY (max_months / 12.0) - experience_years DESC
LIMIT 30;

WITH x AS (
  SELECT
    id, name, experience_years,
    (SELECT max(value::numeric)
       FROM jsonb_each_text(raw_profile->'skillYears')
      WHERE key NOT LIKE '\_%' AND value ~ '^[0-9]+$') AS max_months
  FROM candidates
  WHERE data_env = 'prod' AND merged_into IS NULL
    AND raw_profile->'skillYears' IS NOT NULL
    AND experience_years IS NOT NULL AND experience_years > 0
)
SELECT
  count(*)                                                        AS 判定対象,
  count(*) FILTER (WHERE max_months > (experience_years + 1) * 12) AS 超過あり,
  round(100.0 * count(*) FILTER (WHERE max_months > (experience_years + 1) * 12)
        / NULLIF(count(*), 0), 1)                                 AS 超過率,
  count(*) FILTER (WHERE max_months > (experience_years + 5) * 12) AS 五年以上超過
FROM x;

