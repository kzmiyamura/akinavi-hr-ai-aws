-- 「別会社が同じ人材を紹介」の妥当性をスキル一致度で検証する（2026-08-20）
--
-- ①（氏名＋年齢＋最寄駅の一致）で拾ったペアについて、
-- スキル集合の Jaccard 係数（共通 / 和集合）を計算する。
-- アプリの重複判定は「名前一致 + Jaccard >= 0.4」を採用しているので、同じ基準で見る。
WITH c AS (
  SELECT id, name, from_company,
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
    AND name IS NOT NULL AND raw_profile->>'age' IS NOT NULL
    AND coalesce(raw_profile->>'nearestStation','') <> ''
),
pairs AS (
  SELECT a.id AS id_a, b.id AS id_b, a.name AS name_a,
         a.from_company AS co_a, b.from_company AS co_b,
         (SELECT count(*) FROM (
            SELECT lower(s) AS s FROM jsonb_array_elements_text(a.skills) s
            INTERSECT
            SELECT lower(s) FROM jsonb_array_elements_text(b.skills) s) i) AS inter,
         (SELECT count(*) FROM (
            SELECT lower(s) AS s FROM jsonb_array_elements_text(a.skills) s
            UNION
            SELECT lower(s) FROM jsonb_array_elements_text(b.skills) s) u) AS uni
  FROM c a JOIN c b
    ON a.name_key = b.name_key AND a.age = b.age AND a.station_key = b.station_key
   AND a.company_key <> b.company_key AND a.id < b.id
),
scored AS (
  SELECT *, CASE WHEN uni = 0 THEN 0 ELSE inter::numeric / uni END AS jaccard FROM pairs
)
SELECT '別会社ペアの総数' AS 指標, count(*)::text AS 値 FROM scored
UNION ALL SELECT '  スキル一致度 0.4以上（アプリの重複判定と同基準・ほぼ確実に同一人物）',
  count(*)::text FROM scored WHERE jaccard >= 0.4
UNION ALL SELECT '  0.2〜0.4（同一人物の可能性が高い）', count(*)::text FROM scored WHERE jaccard >= 0.2 AND jaccard < 0.4
UNION ALL SELECT '  0.2未満（別人の可能性あり）', count(*)::text FROM scored WHERE jaccard < 0.2
UNION ALL SELECT '  平均一致度', round(avg(jaccard), 2)::text FROM scored
UNION ALL SELECT '★ 0.2以上のペアに含まれる人材レコード数',
  (SELECT count(DISTINCT x) FROM (
     SELECT id_a AS x FROM scored WHERE jaccard >= 0.2
     UNION SELECT id_b FROM scored WHERE jaccard >= 0.2) t)::text;
