-- 人材の役割（roles）の妥当性調査 その1: 全体の分布（2026-08-19）
-- 役割は本文＋添付の文章から regex でスコアリングして付けている（scoreProseRoles）。
-- まず「何がどれだけ付いているか」を見て、明らかに多すぎる／少なすぎるものを探す。
WITH r AS (
  SELECT c.id, jsonb_array_elements_text(coalesce(c.raw_profile->'roles','[]'::jsonb)) AS role
  FROM candidates c WHERE c.data_env='prod' AND c.merged_into IS NULL
),
total AS (SELECT count(*) AS n FROM candidates WHERE data_env='prod' AND merged_into IS NULL)
SELECT r.role AS 役割,
       count(*)::text AS 人数,
       round(100.0 * count(*) / (SELECT n FROM total), 1)::text || '%' AS 割合
FROM r GROUP BY r.role
ORDER BY count(*) DESC;
