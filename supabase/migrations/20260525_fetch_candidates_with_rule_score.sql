-- fetch_candidates_for_project をルールスコア順に再定義
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], int);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, int);

-- plpgsql で必須スキルを1回だけ正規化し、skill_hits を LATERAL で1回だけ計算する。
-- unnest(p_required_skills) を行ごとに繰り返さないため statement timeout を回避できる。
CREATE FUNCTION fetch_candidates_for_project(
  p_data_env        text,
  p_required_skills text[]  DEFAULT NULL,
  p_budget_min      numeric DEFAULT NULL,
  p_budget_max      numeric DEFAULT NULL,
  p_work_location   text    DEFAULT NULL,
  p_remote_policy   text    DEFAULT NULL,
  p_limit           int     DEFAULT 2000
)
RETURNS SETOF candidates
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_skills    text[];   -- 正規化済み必須スキル（1回だけ計算）
  v_skills_len int;
BEGIN
  -- 必須スキルを正規化してローカル変数に保持（行ごとに unnest しない）
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
  -- ① スキルヒット数を1回だけ計算
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN v_skills IS NULL OR v_skills_len = 0 THEN 0::bigint
        ELSE (
          SELECT COUNT(*)
            FROM jsonb_array_elements_text(c.skills) s
           WHERE lower(trim(s)) = ANY(v_skills)
        )
      END AS skill_hits
  ) sh
  -- ② ルールスコアを計算（skill_hits を再利用）
  CROSS JOIN LATERAL (
    SELECT
      -- スキル一致 (0〜40pt)
      LEAST(40,
        CASE
          WHEN v_skills IS NULL OR v_skills_len = 0 THEN 20
          ELSE ROUND(sh.skill_hits::numeric / NULLIF(v_skills_len, 0) * 40)
        END
      )
      -- 経験年数 (0〜15pt)
      + CASE
          WHEN c.experience_years IS NULL THEN 5
          WHEN c.experience_years >= 10   THEN 15
          WHEN c.experience_years >= 7    THEN 12
          WHEN c.experience_years >= 5    THEN 8
          WHEN c.experience_years >= 3    THEN 4
          WHEN c.experience_years >= 1    THEN 2
          ELSE 0
        END
      -- 単価合致 (0〜15pt)
      + CASE
          WHEN p_budget_max IS NULL THEN 15
          WHEN (regexp_match(COALESCE(c.desired_rate, ''), '(\d+(?:\.\d+)?)\s*万'))[1] IS NULL THEN 0
          WHEN (regexp_match(COALESCE(c.desired_rate, ''), '(\d+(?:\.\d+)?)\s*万'))[1]::numeric
               BETWEEN COALESCE(p_budget_min, 0) AND p_budget_max THEN 15
          WHEN (regexp_match(COALESCE(c.desired_rate, ''), '(\d+(?:\.\d+)?)\s*万'))[1]::numeric
               <= p_budget_max * 1.1 THEN 8
          WHEN (regexp_match(COALESCE(c.desired_rate, ''), '(\d+(?:\.\d+)?)\s*万'))[1]::numeric
               <= p_budget_max * 1.2 THEN 3
          ELSE 0
        END
      -- 勤務地 (0〜20pt)
      + CASE
          WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 20
          WHEN p_work_location IS NULL OR p_work_location = '' THEN 5
          WHEN COALESCE(c.raw_profile->>'prefecture', '') = '' THEN 5
          WHEN lower(p_work_location) LIKE '%' ||
               lower(regexp_replace(COALESCE(c.raw_profile->>'prefecture', ''), '[都道府県]$', '')) || '%'
               THEN 20
          ELSE 0
        END
      -- リモート (0〜10pt)
      + CASE
          WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 0
          WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
               AND p_remote_policy ~ 'リモート|remote|在宅' THEN 10
          ELSE 0
        END
      AS rule_score
  ) rs
  WHERE c.data_env      = p_data_env
    AND c.merged_into   IS NULL
    AND c.duplicate_flag = false
    -- スキルフィルター: skill_hits を再利用して EXISTS サブクエリを排除
    AND (
      v_skills IS NULL
      OR v_skills_len = 0
      OR sh.skill_hits > 0
    )
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$$;
