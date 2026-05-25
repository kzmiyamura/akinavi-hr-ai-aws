-- duplicate_flag=true の人材をマッチング対象から SQL 側で除外する
-- （従来は JS 側でフィルターしていた）

CREATE OR REPLACE FUNCTION fetch_candidates_for_matching(
  p_data_env text,
  p_limit     int DEFAULT 800
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

CREATE OR REPLACE FUNCTION fetch_candidates_for_project(
  p_data_env text,
  p_skills   text[],
  p_limit    int DEFAULT 500
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
