-- 別会社から同じ人材が来ている例を見る（2026-08-20）
-- 判定は「氏名＋年齢＋最寄駅の一致」。スキルの重なりも出して妥当性を確認する。
WITH c AS (
  SELECT id, name, from_company,
         lower(regexp_replace(coalesce(name,''), '[[:space:]　・.,]', '', 'g')) AS name_key,
         nullif(raw_profile->>'age','')::int AS age,
         lower(regexp_replace(coalesce(raw_profile->>'nearestStation',''), '[[:space:]　駅]', '', 'g')) AS station_key,
         coalesce(
           nullif(lower(regexp_replace(coalesce(from_company,''), '[[:space:]　・.,（）()株式会社有限会社]', '', 'g')), ''),
           split_part(coalesce(raw_profile->>'from',''), '@', 2)
         ) AS company_key,
         coalesce(skills, '[]'::jsonb) AS skills,
         desired_rate, experience_years, created_at
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL
),
g AS (
  SELECT name_key, age, station_key
  FROM c
  WHERE name_key <> '' AND age IS NOT NULL AND station_key <> ''
  GROUP BY 1,2,3
  HAVING count(DISTINCT company_key) >= 2
  LIMIT 8
)
SELECT c.name AS 氏名,
       c.age::text AS 年齢,
       coalesce(c.from_company, '(会社不明)') AS 紹介会社,
       coalesce(c.desired_rate, '-') AS 単価,
       coalesce(c.experience_years::text, '-') AS 経験年数,
       jsonb_array_length(c.skills)::text AS スキル数,
       (SELECT count(*) FROM jsonb_array_elements_text(c.skills) s
         WHERE s IN (SELECT jsonb_array_elements_text(c2.skills) FROM c c2
                     WHERE c2.name_key=c.name_key AND c2.age=c.age AND c2.station_key=c.station_key
                       AND c2.id <> c.id LIMIT 1))::text AS 相手と共通のスキル数,
       c.created_at::date::text AS 登録日
FROM c JOIN g ON g.name_key=c.name_key AND g.age=c.age AND g.station_key=c.station_key
ORDER BY c.name_key, c.age, c.created_at;
