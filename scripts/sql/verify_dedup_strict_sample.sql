-- 厳しくした判定で、実際に何が返るかを確認する（2026-08-20）
-- ユーザー指摘の「S.Y」で、駅・年齢がバラバラの別人が消えたかを見る。
WITH target AS (
  SELECT id, name,
         raw_profile->>'nearestStation' AS st,
         raw_profile->>'age' AS age,
         from_company
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL
    AND normalize_candidate_name(name) = 'SY'
  ORDER BY created_at DESC
  LIMIT 1
)
SELECT t.name AS 元の人材,
       coalesce(t.st,'-') AS 元の駅,
       coalesce(t.age,'-') AS 元の年齢,
       coalesce(t.from_company,'-') AS 元の会社,
       coalesce(r.name,'(該当なし)') AS 返った相手,
       coalesce(r.raw_profile->>'nearestStation','-') AS 相手の駅,
       coalesce(r.raw_profile->>'age','-') AS 相手の年齢,
       coalesce(r.from_company,'-') AS 相手の会社,
       coalesce(r.desired_rate,'-') AS 相手の単価
FROM target t
LEFT JOIN LATERAL (
  SELECT * FROM find_duplicate_candidates(t.name, t.id, 'prod')
) r ON true;
