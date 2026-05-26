-- 地方マッピング関数
CREATE OR REPLACE FUNCTION get_region(p_pref_core text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_pref_core IN ('北海道') THEN '北海道'
    WHEN p_pref_core IN ('青森','岩手','宮城','秋田','山形','福島') THEN '東北'
    WHEN p_pref_core IN ('茨城','栃木','群馬','埼玉','千葉','東京','神奈川') THEN '関東'
    WHEN p_pref_core IN ('新潟','山梨','長野') THEN '甲信越'
    WHEN p_pref_core IN ('富山','石川','福井') THEN '北陸'
    WHEN p_pref_core IN ('岐阜','静岡','愛知','三重') THEN '東海'
    WHEN p_pref_core IN ('滋賀','京都','大阪','兵庫','奈良','和歌山') THEN '近畿'
    WHEN p_pref_core IN ('鳥取','島根','岡山','広島','山口') THEN '中国'
    WHEN p_pref_core IN ('徳島','香川','愛媛','高知') THEN '四国'
    WHEN p_pref_core IN ('福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄') THEN '九州'
    ELSE NULL
  END
$$;

-- fetch_candidates_for_project を地方スコアリング対応版に更新
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
  v_skills     text[];
  v_skills_len int;
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
      COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート' AS is_full_remote,
      lower(regexp_replace(COALESCE(c.raw_profile->>'prefecture',''), '[都道府県]$', '')) AS pref_core,
      -- 案件勤務地から都道府県コアを抽出（例: "東京都 大森" → "東京"）
      lower(COALESCE(
        (regexp_match(lower(COALESCE(p_work_location,'')), '^([^\s\u3000]+?)[都道府県]'))[1],
        ''
      )) AS work_pref_core
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
      -- 勤務地（同一都道府県 20pt、同一地方 10pt、不明 5pt、不一致 0pt）
      + ROUND(CASE
          WHEN pre.is_full_remote THEN 1.0
          WHEN p_work_location IS NULL OR p_work_location = '' THEN 5.0/20.0
          WHEN COALESCE(c.raw_profile->>'prefecture','') = ''  THEN 5.0/20.0
          WHEN lower(p_work_location) LIKE '%' || pre.pref_core || '%'
               AND pre.pref_core != ''                         THEN 1.0
          -- 同一地方チェック
          WHEN pre.pref_core != ''
               AND pre.work_pref_core != ''
               AND get_region(pre.pref_core) IS NOT NULL
               AND get_region(pre.pref_core) = get_region(pre.work_pref_core)
                                                               THEN 0.5
          ELSE 0.0
        END * p_weight_location)
      -- リモート
      + ROUND(CASE
          WHEN pre.is_full_remote THEN 0.0
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
