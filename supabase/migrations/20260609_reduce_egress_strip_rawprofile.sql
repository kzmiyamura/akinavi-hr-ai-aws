-- Egress削減: search_candidates / fetch_candidates_for_matching / fetch_candidates_for_project
-- の返却データから raw_profile.text と raw_profile.parsedGrid を除外する。
-- これらはメール本文全文・Excelパース済みグリッドで、UIの一覧・検索・マッチング画面では不要。
-- 詳細表示時は fetch_candidate_raw_profile RPC で個別取得する（既実装）。
--
-- 変更前: 1件 ≈ 14KB × 最大2000件 = 最大28MB/回
-- 変更後: 1件 ≈ 2KB  × 最大2000件 = 最大4MB/回（約85%削減）

-- ① candidates_lite ビューに updated_by を追加して再作成
DROP VIEW IF EXISTS candidates_lite CASCADE;

CREATE VIEW candidates_lite AS
SELECT
  id, name, email, phone, skills, experience_years, desired_rate,
  from_company, resume_url, drive_url, box_url, box_status,
  created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
  (raw_profile - 'text' - 'parsedGrid') AS raw_profile
FROM candidates;

GRANT SELECT ON candidates_lite TO anon, authenticated;

-- ② fetch_candidate_raw_profile を再作成（CASCADE で DROP されたため）
CREATE OR REPLACE FUNCTION fetch_candidate_raw_profile(p_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT raw_profile FROM candidates WHERE id = p_id LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION fetch_candidate_raw_profile(uuid) TO anon, authenticated;

-- ③ fetch_candidates_for_matching を candidates_lite に変更
DROP FUNCTION IF EXISTS fetch_candidates_for_matching(text, int);

CREATE FUNCTION fetch_candidates_for_matching(
  p_data_env text,
  p_limit    int DEFAULT 2000
)
RETURNS SETOF candidates_lite
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT *
  FROM candidates_lite
  WHERE data_env      = p_data_env
    AND merged_into   IS NULL
    AND duplicate_flag = false
  ORDER BY
    created_at DESC,
    COALESCE(experience_years, 0) DESC
  LIMIT p_limit;
$$;

-- ④ search_candidates を candidates_lite に変更
DROP FUNCTION IF EXISTS search_candidates(text, text[], text, int, int, text);

CREATE FUNCTION search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode     text DEFAULT 'AND',
  p_limit    int  DEFAULT 100,
  p_offset   int  DEFAULT 0,
  p_scope    text DEFAULT 'all'
)
RETURNS SETOF candidates_lite
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw         text;
  pat        text;
  cond       text;
  conditions text[] := '{}';
  search_expr text;
  q          text;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    pat := '%' || kw || '%';
    IF p_scope = 'tags' THEN
      cond := format(
        '(name ILIKE %L
          OR skills::text ILIKE %L
          OR COALESCE(desired_rate,'''') ILIKE %L
          OR COALESCE(from_company,'''') ILIKE %L
          OR COALESCE(raw_profile->>''prefecture'','''') ILIKE %L
          OR COALESCE(raw_profile->>''nearestStation'','''') ILIKE %L
          OR COALESCE(raw_profile->>''currentWorkLocation'','''') ILIKE %L
          OR COALESCE(raw_profile->>''summary'','''') ILIKE %L
          OR COALESCE(raw_profile->>''agentComment'','''') ILIKE %L
          OR COALESCE((raw_profile->''skillsByCategory'')::text,'''') ILIKE %L
          OR COALESCE((raw_profile->''roles'')::text,'''') ILIKE %L
          OR COALESCE((raw_profile->''industries'')::text,'''') ILIKE %L)',
        pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat
      );
    ELSIF p_scope = 'body' THEN
      -- body スコープ: raw_profile.text を直接参照するため candidates テーブルを使う
      cond := format(
        'COALESCE(raw_profile->>''text'','''') ILIKE %L',
        pat
      );
    ELSE
      cond := format(
        '(name ILIKE %L OR skills::text ILIKE %L OR raw_profile::text ILIKE %L)',
        pat, pat, pat
      );
    END IF;
    conditions := conditions || cond;
  END LOOP;

  IF cardinality(conditions) = 0 THEN
    IF p_scope = 'body' THEN
      -- body スコープは candidates テーブルから返す（text フィールドが必要なため）
      RETURN QUERY
        SELECT id, name, email, phone, skills, experience_years, desired_rate,
               from_company, resume_url, drive_url, box_url, box_status,
               created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
               (raw_profile - 'text' - 'parsedGrid') AS raw_profile
        FROM candidates
        WHERE data_env = p_data_env AND merged_into IS NULL
        ORDER BY updated_at DESC
        LIMIT p_limit OFFSET p_offset;
    ELSE
      RETURN QUERY
        SELECT * FROM candidates_lite
        WHERE data_env = p_data_env AND merged_into IS NULL
        ORDER BY updated_at DESC
        LIMIT p_limit OFFSET p_offset;
    END IF;
    RETURN;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(conditions, ' AND ');
  ELSE
    search_expr := array_to_string(conditions, ' OR ');
  END IF;

  IF p_scope = 'body' THEN
    -- body スコープ: candidates テーブルから検索しつつ lite 形式で返す
    q := format(
      'SELECT id, name, email, phone, skills, experience_years, desired_rate,
              from_company, resume_url, drive_url, box_url, box_status,
              created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
              (raw_profile - ''text'' - ''parsedGrid'') AS raw_profile
       FROM candidates
       WHERE data_env = %L AND merged_into IS NULL AND (%s)
       ORDER BY updated_at DESC LIMIT %s OFFSET %s',
      p_data_env, search_expr, p_limit, p_offset
    );
  ELSE
    q := format(
      'SELECT * FROM candidates_lite WHERE data_env = %L AND merged_into IS NULL AND (%s) ORDER BY updated_at DESC LIMIT %s OFFSET %s',
      p_data_env, search_expr, p_limit, p_offset
    );
  END IF;

  RETURN QUERY EXECUTE q;
END;
$$;

-- ⑤ fetch_candidates_for_project を candidates_lite に変更
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean);

CREATE FUNCTION public.fetch_candidates_for_project(
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
  p_require_haken    boolean DEFAULT false
)
RETURNS SETOF candidates_lite
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
    FROM candidates_lite c
    WHERE c.data_env    = p_data_env
      AND c.merged_into IS NULL
      AND c.duplicate_flag = false
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
  FROM candidates_lite c
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
