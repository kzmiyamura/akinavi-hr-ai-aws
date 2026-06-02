-- リモートスコアリングの改善
-- 変更点:
--   1. wantsFullRemote=true + 案件にリモート記載なし → -weight_remote（減点）
--      ※ 旧実装の「30pt上限キャップ」をより比例的な減点に置き換え
--   2. remoteAvailable が NULL（不明）→ +weight_remote*0.5 の中間点
--   3. total が 0 を下回らないよう GREATEST(0, ...) を追加

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

  -- 案件側の都道府県コア・地方・フルリモート・リモートありを事前に1回だけ計算
  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';
  v_project_has_remote := v_is_full_remote OR COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅';
  v_loc_lower := lower(trim(COALESCE(p_work_location, '')));

  -- 都道府県コア抽出: 「大阪府 新大阪」→「大阪」
  -- フォールバック: 「大阪」(府なし) → 空白前の最初トークンから市区町村サフィックスを除去 → 「大阪」
  v_work_pref_core := COALESCE(
    -- まず都/道/府/県 サフィックスがある表記を抽出
    (regexp_match(p_work_location, '(\S+?)[都道府県]'))[1],
    -- なければ最初の空白区切りトークンから市区町村サフィックスを除去
    regexp_replace(
      split_part(trim(COALESCE(p_work_location, '')), ' ', 1),
      '(市|区|町|村|郡).*$', ''
    )
  );

  -- 同一都道府県の地方を取得
  v_work_region := get_region(v_work_pref_core);

  RETURN QUERY
  WITH pre AS (
    SELECT
      c.id,
      -- 人材の都道府県コア
      COALESCE(
        (regexp_match(c.raw_profile->>'prefecture', '(\S+?)[都道府県]'))[1],
        regexp_replace(
          split_part(trim(COALESCE(c.raw_profile->>'prefecture', '')), ' ', 1),
          '(市|区|町|村|郡).*$', ''
        )
      ) AS pref_core,
      -- 希望単価（万円）
      NULLIF(REGEXP_REPLACE(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, ''), '[^0-9.]', '', 'g'), '')::numeric AS rate_val,
      -- スキル一致数
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
  )
  SELECT c.*
  FROM candidates c
  JOIN pre ON pre.id = c.id
  CROSS JOIN LATERAL (
    SELECT
      GREATEST(0,
        -- スキル一致
        ROUND(CASE
            WHEN v_skills_len = 0         THEN 20.0/40.0
            WHEN pre.hits = 0             THEN 0.0
            ELSE LEAST(pre.hits::numeric / v_skills_len, 1.0)
          END * p_weight_skill)
        -- 経験年数
        + ROUND(CASE
            WHEN c.experience_years IS NULL THEN 8.0/15.0
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
        -- wantsFullRemote=true + 案件にリモートなし → -weight_remote（減点）
        -- remoteAvailable=true + 案件にリモートあり → +weight_remote
        -- remoteAvailable=null（不明）             → +weight_remote*0.5（中間点）
        -- それ以外                                 → 0
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
$$;
