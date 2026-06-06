-- fetch_candidates_for_project に派遣免許フィルターを追加
-- p_require_haken = true の場合、agent_companies.license_status が haken/both の会社のみ返す

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.fetch_candidates_for_project(
  p_data_env         text,
  p_required_skills  text[]  DEFAULT NULL,
  p_budget_min       numeric DEFAULT NULL,
  p_budget_max       numeric DEFAULT NULL,
  p_work_location    text    DEFAULT NULL,
  p_remote_policy    text    DEFAULT NULL,
  p_limit            integer DEFAULT 500,
  p_weight_skill     integer DEFAULT 40,
  p_weight_exp       integer DEFAULT 15,
  p_weight_rate      integer DEFAULT 15,
  p_weight_location  integer DEFAULT 20,
  p_weight_remote    integer DEFAULT 10,
  p_require_haken    boolean DEFAULT false   -- ← 新規: 派遣免許確認済み会社のみ
)
RETURNS SETOF candidates
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_skills          text[];
  v_skills_len      int;
  v_work_pref_core  text;
  v_work_region     text;
  v_is_full_remote  boolean;
  v_project_has_remote boolean;
  v_loc_lower       text;
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

  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';
  v_project_has_remote := v_is_full_remote OR COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅';
  v_loc_lower := lower(trim(COALESCE(p_work_location, '')));

  v_work_pref_core := COALESCE(
    (regexp_match(p_work_location, '(\S+?)[都道府県]'))[1],
    regexp_replace(
      split_part(trim(COALESCE(p_work_location, '')), ' ', 1),
      '(市|区|町|村|郡).*$', ''
    )
  );
  v_work_region := get_region(v_work_pref_core);

  RETURN QUERY
  WITH pre AS (
    SELECT
      c.id,
      COALESCE(
        (regexp_match(c.raw_profile->>'prefecture', '(\S+?)[都道府県]'))[1],
        regexp_replace(
          split_part(trim(COALESCE(c.raw_profile->>'prefecture', '')), ' ', 1),
          '(市|区|町|村|郡).*$', ''
        )
      ) AS pref_core,
      NULLIF(REGEXP_REPLACE(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, ''), '[^0-9.]', '', 'g'), '')::numeric AS rate_val,
      (SELECT count(*) FROM jsonb_array_elements_text(c.skills) s
        WHERE v_skills IS NOT NULL AND v_skills_len > 0
          AND EXISTS (
            SELECT 1 FROM unnest(v_skills) q
            WHERE lower(s) LIKE '%' || q || '%' OR q LIKE '%' || lower(s) || '%'
          )
      ) AS hits
    FROM candidates c
    WHERE c.data_env    = p_data_env
      AND c.merged_into IS NULL
      AND c.duplicate_flag = false
      -- 派遣フィルター: p_require_haken=true の場合はドメインが haken/both の会社のみ
      AND (
        NOT p_require_haken
        OR EXISTS (
          SELECT 1 FROM agent_companies ac
          WHERE ac.domain = LOWER(SPLIT_PART(c.raw_profile->>'from', '@', 2))
            AND ac.license_status IN ('haken', 'both')
        )
      )
  )
  SELECT c.*
  FROM candidates c
  JOIN pre ON pre.id = c.id
  CROSS JOIN LATERAL (
    SELECT
      GREATEST(0,
        ROUND(CASE
            WHEN v_skills_len = 0         THEN 20.0/40.0
            WHEN pre.hits = 0             THEN 0.0
            ELSE LEAST(pre.hits::numeric / v_skills_len, 1.0)
          END * p_weight_skill)
        + ROUND(CASE
            WHEN c.experience_years IS NULL THEN 8.0/15.0
            WHEN c.experience_years >= 10   THEN 1.0
            WHEN c.experience_years >= 7    THEN 12.0/15.0
            WHEN c.experience_years >= 5    THEN 8.0/15.0
            WHEN c.experience_years >= 3    THEN 4.0/15.0
            WHEN c.experience_years >= 1    THEN 2.0/15.0
            ELSE 0.0
          END * p_weight_exp)
        + ROUND(CASE
            WHEN p_budget_max IS NULL          THEN 1.0
            WHEN pre.rate_val IS NULL          THEN 0.0
            WHEN pre.rate_val <= p_budget_max  THEN 1.0
            WHEN pre.rate_val <= p_budget_max * 1.1 THEN 8.0/15.0
            WHEN pre.rate_val <= p_budget_max * 1.2 THEN 3.0/15.0
            ELSE 0.0
          END * p_weight_rate)
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
        + ROUND(CASE
            WHEN (c.raw_profile->>'wantsFullRemote')::boolean = true
                 AND NOT v_project_has_remote                       THEN -1.0
            WHEN v_is_full_remote                                   THEN 0.0
            WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
                 AND COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅' THEN 1.0
            WHEN (c.raw_profile->>'remoteAvailable') IS NULL        THEN 0.5
            ELSE 0.0
          END * p_weight_remote)
      ) AS rule_score
  ) rs
  WHERE c.data_env      = p_data_env
    AND c.merged_into   IS NULL
    AND c.duplicate_flag = false
    AND (v_skills IS NULL OR v_skills_len = 0 OR pre.hits > 0)
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$function$;
