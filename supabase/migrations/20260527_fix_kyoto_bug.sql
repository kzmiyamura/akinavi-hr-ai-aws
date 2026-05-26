-- 勤務地マッチングの部分一致バグ修正
-- 「東京都 大森」に「京都」が LIKE '%京都%' でヒットしてしまう問題を修正
-- pref_core と work_pref_core の完全一致に変更

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], int);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, int);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, int, int, int, int, int, int);

CREATE FUNCTION fetch_candidates_for_project(
  p_data_env        text,
  p_required_skills text[]  DEFAULT NULL,
  p_budget_min      numeric DEFAULT NULL,
  p_budget_max      numeric DEFAULT NULL,
  p_work_location   text    DEFAULT NULL,
  p_remote_policy   text    DEFAULT NULL,
  p_limit           int     DEFAULT 500,
  p_weight_skill    int     DEFAULT 40,
  p_weight_exp      int     DEFAULT 15,
  p_weight_rate     int     DEFAULT 15,
  p_weight_location int     DEFAULT 20,
  p_weight_remote   int     DEFAULT 10
)
RETURNS SETOF candidates
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_skills          text[];
  v_skills_len      int;
  v_work_pref_core  text;
  v_work_region     text;
  v_is_full_remote  boolean;
BEGIN
  PERFORM set_config('statement_timeout', '30000', true);

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

  -- 案件側の都道府県コア・地方・フルリモートを事前に1回だけ計算
  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';
  v_work_pref_core := lower(COALESCE(
    (regexp_match(lower(COALESCE(p_work_location,'')), '^([^\s\u3000]+?)[都道府県]'))[1],
    ''
  ));
  v_work_region := get_region(v_work_pref_core);

  RETURN QUERY
  SELECT c.*
  FROM candidates c
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN v_skills IS NULL OR v_skills_len = 0 THEN 0::bigint
        ELSE (SELECT COUNT(*) FROM jsonb_array_elements_text(c.skills) s
              WHERE lower(trim(s)) = ANY(v_skills))
      END AS hits,
      (regexp_match(COALESCE(c.desired_rate,''), '(\d+(?:\.\d+)?)\s*万'))[1]::numeric AS rate_val,
      lower(regexp_replace(COALESCE(c.raw_profile->>'prefecture',''), '[都道府県]$', '')) AS pref_core
  ) pre
  CROSS JOIN LATERAL (
    SELECT
      -- スキル
      LEAST(p_weight_skill,
        CASE
          WHEN v_skills IS NULL OR v_skills_len = 0
            THEN ROUND(0.5 * p_weight_skill)
          ELSE ROUND(pre.hits::numeric / v_skills_len * p_weight_skill)
        END
      )
      -- 経験年数
      + ROUND(CASE
          WHEN c.experience_years IS NULL THEN 5.0/15.0
          WHEN c.experience_years >= 10   THEN 1.0
          WHEN c.experience_years >= 7    THEN 12.0/15.0
          WHEN c.experience_years >= 5    THEN 8.0/15.0
          WHEN c.experience_years >= 3    THEN 4.0/15.0
          WHEN c.experience_years >= 1    THEN 2.0/15.0
          ELSE 0.0
        END * p_weight_exp)
      -- 単価
      + ROUND(CASE
          WHEN p_budget_max IS NULL          THEN 1.0
          WHEN pre.rate_val IS NULL          THEN 0.0
          WHEN pre.rate_val <= p_budget_max  THEN 1.0
          WHEN pre.rate_val <= p_budget_max * 1.1 THEN 8.0/15.0
          WHEN pre.rate_val <= p_budget_max * 1.2 THEN 3.0/15.0
          ELSE 0.0
        END * p_weight_rate)
      -- 勤務地（同一都道府県20pt、同一地方10pt、不明5pt、不一致0pt）
      -- pref_core と v_work_pref_core の完全一致で判定（部分一致バグを修正）
      + ROUND(CASE
          WHEN v_is_full_remote THEN 1.0
          WHEN p_work_location IS NULL OR p_work_location = '' THEN 5.0/20.0
          WHEN COALESCE(c.raw_profile->>'prefecture','') = ''  THEN 5.0/20.0
          WHEN pre.pref_core != ''
               AND v_work_pref_core != ''
               AND pre.pref_core = v_work_pref_core              THEN 1.0
          WHEN pre.pref_core != ''
               AND v_work_region IS NOT NULL
               AND get_region(pre.pref_core) = v_work_region  THEN 0.5
          ELSE 0.0
        END * p_weight_location)
      -- リモート
      + ROUND(CASE
          WHEN v_is_full_remote THEN 0.0
          WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
               AND p_remote_policy ~ 'リモート|remote|在宅'    THEN 1.0
          ELSE 0.0
        END * p_weight_remote)
      AS rule_score
  ) rs
  WHERE c.data_env      = p_data_env
    AND c.merged_into   IS NULL
    AND c.duplicate_flag = false
    AND (v_skills IS NULL OR v_skills_len = 0 OR pre.hits > 0)
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$$;
