-- fetch_candidates_for_project をルールスコア順に再定義
-- 戻り値の型が変わるため一旦 DROP してから CREATE する
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], int);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, int);

-- RETURNS SETOF candidates のまま維持しつつ、ORDER BY をルールスコア降順に変更。
-- ルールスコアは ORDER BY 内でのみ計算し、戻り値には含めない。
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
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.*
  FROM candidates c
  WHERE c.data_env      = p_data_env
    AND c.merged_into   IS NULL
    AND c.duplicate_flag = false
    AND (
      p_required_skills IS NULL
      OR array_length(p_required_skills, 1) = 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(c.skills) s
        WHERE lower(trim(s)) = ANY(SELECT lower(trim(x)) FROM unnest(p_required_skills) x)
      )
    )
  ORDER BY (
    -- ── スキル一致 (0〜40pt) ──
    LEAST(40,
      CASE
        WHEN p_required_skills IS NULL OR array_length(p_required_skills, 1) = 0 THEN 20
        ELSE ROUND(
          (SELECT COUNT(*)::numeric
             FROM jsonb_array_elements_text(c.skills) s
            WHERE lower(trim(s)) = ANY(SELECT lower(trim(x)) FROM unnest(p_required_skills) x)
          ) / NULLIF(array_length(p_required_skills, 1), 0) * 40
        )
      END
    )
    -- ── 経験年数 (0〜15pt) ──
    + CASE
        WHEN c.experience_years >= 10 THEN 15
        WHEN c.experience_years >= 7  THEN 12
        WHEN c.experience_years >= 5  THEN 8
        WHEN c.experience_years >= 3  THEN 4
        WHEN c.experience_years >= 1  THEN 2
        ELSE 0
      END
    -- ── 単価合致 (0〜15pt) ──
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
    -- ── 勤務地 (0〜20pt) ──
    + CASE
        WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 20
        WHEN p_work_location IS NULL OR p_work_location = '' THEN 5
        WHEN c.raw_profile->>'prefecture' IS NULL OR c.raw_profile->>'prefecture' = '' THEN 5
        WHEN lower(p_work_location) LIKE '%' ||
             lower(regexp_replace(COALESCE(c.raw_profile->>'prefecture', ''), '[都道府県]$', '')) || '%'
             AND COALESCE(c.raw_profile->>'prefecture', '') <> '' THEN 20
        ELSE 0
      END
    -- ── リモート対応 (0〜10pt) ──
    + CASE
        WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 0
        WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
             AND p_remote_policy ~ 'リモート|remote|在宅' THEN 10
        ELSE 0
      END
  ) DESC,
  c.created_at DESC
  LIMIT p_limit;
$$;
