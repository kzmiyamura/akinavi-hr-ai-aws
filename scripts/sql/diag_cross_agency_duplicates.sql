-- 別の紹介会社が同じ人材を送ってきているケースを数える（2026-08-20）
--
-- 判別方法（DB内の情報だけで、強い順に3段階）:
--   ① 氏名（記号・空白を除いた正規化）＋ 年齢 ＋ 最寄駅 が一致
--      → イニシャル表記でも、年齢と駅まで揃えばほぼ同一人物
--   ② 氏名 ＋ 年齢 が一致（駅は片方が未取得のことがあるため緩める）
--   ③ 年齢 ＋ 最寄駅 ＋ スキルの重なりが大きい（氏名表記が会社ごとに違う場合）
--      → ここでは①②より弱いので参考値として別に出す
--
-- 「別の会社」は from_company の正規化値で判定し、無い場合は送信元ドメインで補う。
WITH c AS (
  SELECT id,
         lower(regexp_replace(coalesce(name,''), '[[:space:]　・.,]', '', 'g')) AS name_key,
         nullif(raw_profile->>'age','')::int AS age,
         lower(regexp_replace(coalesce(raw_profile->>'nearestStation',''), '[[:space:]　駅]', '', 'g')) AS station_key,
         coalesce(
           nullif(lower(regexp_replace(coalesce(from_company,''), '[[:space:]　・.,（）()株式会社有限会社]', '', 'g')), ''),
           split_part(coalesce(raw_profile->>'from',''), '@', 2)
         ) AS company_key,
         coalesce(skills, '[]'::jsonb) AS skills
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL
),
-- ① 氏名＋年齢＋駅
g1 AS (
  SELECT name_key, age, station_key,
         count(*) AS n_rows,
         count(DISTINCT company_key) AS n_companies
  FROM c
  WHERE name_key <> '' AND age IS NOT NULL AND station_key <> ''
  GROUP BY 1,2,3
),
-- ② 氏名＋年齢
g2 AS (
  SELECT name_key, age,
         count(*) AS n_rows,
         count(DISTINCT company_key) AS n_companies
  FROM c
  WHERE name_key <> '' AND age IS NOT NULL
  GROUP BY 1,2
)
SELECT '対象人材（prod・マージ済み除く）' AS 指標, count(*)::text AS 値 FROM c
UNION ALL SELECT '  氏名・年齢・駅がすべて揃っている人', count(*)::text FROM c
  WHERE name_key <> '' AND age IS NOT NULL AND station_key <> ''
UNION ALL SELECT '── ① 氏名＋年齢＋駅 が一致 ──', ''
UNION ALL SELECT '  同一人物とみられるグループ数', count(*)::text FROM g1 WHERE n_rows >= 2
UNION ALL SELECT '  ★うち紹介会社が2社以上', count(*)::text FROM g1 WHERE n_companies >= 2
UNION ALL SELECT '  ★その人材レコード数', coalesce(sum(n_rows),0)::text FROM g1 WHERE n_companies >= 2
UNION ALL SELECT '── ② 氏名＋年齢 が一致（駅は問わない）──', ''
UNION ALL SELECT '  同一人物とみられるグループ数', count(*)::text FROM g2 WHERE n_rows >= 2
UNION ALL SELECT '  ★うち紹介会社が2社以上', count(*)::text FROM g2 WHERE n_companies >= 2
UNION ALL SELECT '  ★その人材レコード数', coalesce(sum(n_rows),0)::text FROM g2 WHERE n_companies >= 2
UNION ALL SELECT '（参考）duplicate_flag が立っている人', count(*)::text
  FROM candidates WHERE data_env='prod' AND merged_into IS NULL AND duplicate_flag;
