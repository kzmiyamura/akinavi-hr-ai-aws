-- 重複RPCが実際に相手を返すかを確認する（2026-08-20）
-- 別会社ペアの片方の id を渡して、find_duplicate_candidates_batch が相手を返すか見る。
WITH c AS (
  SELECT id, name, from_company,
         normalize_candidate_name(name) AS nk,
         nullif(raw_profile->>'age','')::int AS age,
         lower(regexp_replace(coalesce(raw_profile->>'nearestStation',''), '[[:space:]　駅]', '', 'g')) AS sk,
         coalesce(nullif(lower(regexp_replace(coalesce(from_company,''), '[[:space:]　・.,（）()株式会社有限会社]', '', 'g')), ''),
                  split_part(coalesce(raw_profile->>'from',''), '@', 2)) AS ck
  FROM candidates WHERE data_env='prod' AND merged_into IS NULL
),
pair AS (
  SELECT a.id AS id_a, a.name AS name_a, a.from_company AS co_a,
         b.id AS id_b, b.name AS name_b, b.from_company AS co_b
  FROM c a JOIN c b ON a.nk=b.nk AND a.age=b.age AND a.sk=b.sk AND a.ck<>b.ck AND a.id<b.id
  WHERE a.nk <> '' AND a.age IS NOT NULL AND a.sk <> ''
  LIMIT 3
)
SELECT p.name_a AS 元の人材, p.co_a AS 元の会社,
       r.name AS RPCが返した相手, r.from_company AS 相手の会社,
       coalesce(r.desired_rate, '-') AS 相手の単価
FROM pair p
LEFT JOIN LATERAL (
  SELECT * FROM find_duplicate_candidates_batch(ARRAY[p.id_a]::uuid[], 'prod')
) r ON true;
