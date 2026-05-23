-- 人材マップ用 RPC: 都道府県別人材数を集計
-- スキルフィルターあり時は candidate_skills と JOIN して DISTINCT カウント
CREATE OR REPLACE FUNCTION prefecture_counts(p_data_env text, p_skill text DEFAULT NULL)
RETURNS TABLE(prefecture text, cnt bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.raw_profile->>'prefecture' AS prefecture,
    COUNT(DISTINCT c.id) AS cnt
  FROM candidates c
  LEFT JOIN candidate_skills cs ON cs.candidate_id = c.id
  WHERE c.data_env = p_data_env
    AND (p_skill IS NULL OR cs.skill ILIKE '%' || p_skill || '%')
    AND c.raw_profile->>'prefecture' IS NOT NULL
    AND c.raw_profile->>'prefecture' != ''
    AND c.raw_profile->>'prefecture' != '不明'
  GROUP BY c.raw_profile->>'prefecture'
  ORDER BY cnt DESC;
$$;
