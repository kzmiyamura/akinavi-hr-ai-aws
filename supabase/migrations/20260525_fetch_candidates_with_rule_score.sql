-- fetch_candidates_for_project をルールスコア込みで再定義
-- 案件パラメータを受け取り、SQL 内でルールスコアを計算して
-- スコア降順 → 登録日時降順で返す。

CREATE OR REPLACE FUNCTION fetch_candidates_for_project(
  p_data_env        text,
  p_required_skills text[]  DEFAULT NULL,
  p_budget_min      numeric DEFAULT NULL,
  p_budget_max      numeric DEFAULT NULL,
  p_work_location   text    DEFAULT NULL,
  p_remote_policy   text    DEFAULT NULL,
  p_limit           int     DEFAULT 2000
)
RETURNS TABLE (
  id              uuid,
  data_env        text,
  name            text,
  email           text,
  phone           text,
  skills          jsonb,
  experience_years int,
  raw_profile     jsonb,
  duplicate_flag  boolean,
  merged_into     uuid,
  created_by      text,
  updated_by      text,
  created_at      timestamptz,
  updated_at      timestamptz,
  resume_url      text,
  drive_url       text,
  box_url         text,
  box_status      text,
  desired_rate    text,
  from_company    text,
  rule_score      int
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH scored AS (
    SELECT
      c.*,

      -- ── スキル一致 (0〜40pt) ──
      -- 必須スキルが未設定なら固定 20pt
      -- 一致数 / 必須スキル数 × 40（SQL では完全一致のみ）
      LEAST(40,
        CASE
          WHEN p_required_skills IS NULL OR array_length(p_required_skills, 1) = 0 THEN 20
          ELSE ROUND(
            (SELECT COUNT(*)::numeric
               FROM jsonb_array_elements_text(c.skills) s
              WHERE lower(trim(s)) = ANY(SELECT lower(trim(x)) FROM unnest(p_required_skills) x)
            )
            / NULLIF(array_length(p_required_skills, 1), 0) * 40
          )
        END
      )::int

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
      -- desired_rate から "数値万" を抽出して予算と比較
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
               lower(regexp_replace(c.raw_profile->>'prefecture', '[都道府県]$', '')) || '%'
               AND (c.raw_profile->>'prefecture') <> '' THEN 20
          ELSE 0
        END

      -- ── リモート対応 (0〜10pt) ──
      + CASE
          WHEN p_remote_policy ~ 'フルリモート|完全リモート|100[%％]リモート' THEN 0
          WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
               AND p_remote_policy ~ 'リモート|remote|在宅' THEN 10
          ELSE 0
        END

      AS rule_score

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
  )
  SELECT *
  FROM scored
  ORDER BY rule_score DESC, created_at DESC
  LIMIT p_limit;
$$;
