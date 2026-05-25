-- fetch_candidates_for_project をルールスコア順に再定義
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], int);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, int);

CREATE FUNCTION fetch_candidates_for_project(
  p_data_env        text,
  p_required_skills text[]  DEFAULT NULL,
  p_budget_min      numeric DEFAULT NULL,
  p_budget_max      numeric DEFAULT NULL,
  p_work_location   text    DEFAULT NULL,
  p_remote_policy   text    DEFAULT NULL,
  p_limit           int     DEFAULT 500
)
RETURNS SETOF candidates
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_skills     text[];
  v_skills_len int;
BEGIN
  -- タイムアウトをこの関数内だけ 30 秒に延長
  PERFORM set_config('statement_timeout', '30000', true);

  -- 必須スキルを正規化（クエリ実行前に1回だけ）
  IF p_required_skills IS NOT NULL AND array_length(p_required_skills, 1) > 0 THEN
    SELECT array_agg(lower(trim(x)))
      INTO v_skills
      FROM unnest(p_required_skills) x
     WHERE trim(x) != '';
    v_skills_len := coalesce(array_length(v_skills, 1), 0);
  ELSE
    v_skills     := NULL;
    v_skills_len := 0;
  END IF;

  RETURN QUERY
  SELECT c.*
  FROM candidates c
  CROSS JOIN LATERAL (
    -- skill_hits・rule_score を1つの LATERAL でまとめて計算
    SELECT
      hits,
      LEAST(40,
        CASE WHEN v_skills IS NULL OR v_skills_len = 0 THEN 20
             ELSE ROUND(hits::numeric / v_skills_len * 40)
        END
      )
      + CASE
          WHEN c.experience_years IS NULL THEN 5
          WHEN c.experience_years >= 10   THEN 15
          WHEN c.experience_years >= 7    THEN 12
          WHEN c.experience_years >= 5    THEN 8
          WHEN c.experience_years >= 3    THEN 4
          WHEN c.experience_years >= 1    THEN 2
          ELSE 0
        END
      + CASE
          WHEN p_budget_max IS NULL THEN 15
          WHEN (regexp_match(COALESCE(c.desired_rate,''),'(\d+(?:\.\d+)?)\s*万'))[1] IS NULL THEN 0
          WHEN (regexp_match(COALESCE(c.desired_rate,''),'(\d+(?:\.\d+)?)\s*万'))[1]::numeric
               BETWEEN COALESCE(p_budget_min,0) AND p_budget_max THEN 15
          WHEN (regexp_match(COALESCE(c.desired_rate,''),'(\d+(?:\.\d+)?)\s*万'))[1]::numeric
               <= p_budget_max * 1.1 THEN 8
          WHEN (regexp_match(COALESCE(c.desired_rate,''),'(\d+(?:\.\d+)?)\s*万'))[1]::numeric
               <= p_budget_max * 1.2 THEN 3
          ELSE 0
        END
      + CASE
          WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 20
          WHEN p_work_location IS NULL OR p_work_location = '' THEN 5
          WHEN COALESCE(c.raw_profile->>'prefecture','') = '' THEN 5
          WHEN lower(p_work_location) LIKE '%' ||
               lower(regexp_replace(COALESCE(c.raw_profile->>'prefecture',''),'[都道府県]$','')) || '%'
               THEN 20
          ELSE 0
        END
      + CASE
          WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 0
          WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
               AND p_remote_policy ~ 'リモート|remote|在宅' THEN 10
          ELSE 0
        END
      AS rule_score
    FROM (
      SELECT CASE
               WHEN v_skills IS NULL OR v_skills_len = 0 THEN 0::bigint
               ELSE (
                 SELECT COUNT(*)
                   FROM jsonb_array_elements_text(c.skills) s
                  WHERE lower(trim(s)) = ANY(v_skills)
               )
             END AS hits
    ) h
  ) rs
  WHERE c.data_env      = p_data_env
    AND c.merged_into   IS NULL
    AND c.duplicate_flag = false
    AND (v_skills IS NULL OR v_skills_len = 0 OR rs.hits > 0)
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$$;
