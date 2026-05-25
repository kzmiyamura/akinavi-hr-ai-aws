-- duplicate_flag=true の人材をマッチング対象から SQL 側で除外する
-- （従来は JS 側でフィルターしていた）

-- fetch_candidates_for_matching:
--   全候補者取得（案件を指定しない人材→案件マッチング用）
--   上限 2000 に引き上げ（7日分 × 日次件数の上限として十分な余裕）
CREATE OR REPLACE FUNCTION fetch_candidates_for_matching(
  p_data_env text,
  p_limit     int DEFAULT 2000
)
RETURNS SETOF candidates
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT *
  FROM candidates
  WHERE data_env      = p_data_env
    AND merged_into   IS NULL
    AND duplicate_flag = false
  ORDER BY
    created_at DESC,
    COALESCE(experience_years, 0) DESC
  LIMIT p_limit;
$$;

-- fetch_candidates_for_project:
--   案件スキルで絞り込んだ候補者取得（案件→候補者マッチング用）
--   スキルフィルター後の全員を返す（上限 2000）
--   ルールスコアによるグローバルソートは match-batch 側で実施
CREATE OR REPLACE FUNCTION fetch_candidates_for_project(
  p_data_env text,
  p_skills   text[],
  p_limit    int DEFAULT 2000
)
RETURNS SETOF candidates
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT *
  FROM candidates
  WHERE data_env      = p_data_env
    AND merged_into   IS NULL
    AND duplicate_flag = false
    AND (
      p_skills IS NULL
      OR array_length(p_skills, 1) = 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(skills) s
        WHERE lower(s) = ANY(SELECT lower(x) FROM unnest(p_skills) x)
      )
    )
  ORDER BY created_at DESC, COALESCE(experience_years, 0) DESC
  LIMIT p_limit;
$$;
