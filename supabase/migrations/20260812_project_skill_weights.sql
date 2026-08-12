-- 必須スキルに重みを持たせる（2026-08-12）
--
-- 背景: これまで必須スキルの配点は「一致数 ÷ 必須スキル数」で、Java も 基本設計 も同じ1点だった。
-- 「基本設計・テスト・保守開発」のような工程語だけ一致した候補者が、言語が全く合わないのに
-- 上位に来る。営業判断では言語スキルの一致が最も重い。
--
-- 対応: 案件ごとに skill_weights（{"Java":6,"基本設計":1} 形式）を持ち、
--       配点を「一致した重みの合計 ÷ 全必須スキルの重み合計」に変える。
--       skill_weights が NULL のときは全スキル重み1＝従来と同じ挙動（後方互換）。
--
-- 重みは skill_master.category（languages/frameworks/methodologies 等14種）と
-- 本文の記述（年数指定の有無・記載順）から inbound-email が算出する。AIは使わない。
--
-- 併せて、一致判定を「候補者側スキルのうち何件がヒットしたか」から
-- 「必須スキルのうち何件が満たされたか」に直す。前者は候補者が Java, Java8, JavaSE を
-- 持っていると必須「Java」1件に対して3カウントされ、実際の充足度より高く出ていた
-- （LEAST(...,1.0) で頭打ちにはなるが、必須が複数あると他スキルの不足を埋めてしまう）。

ALTER TABLE projects ADD COLUMN IF NOT EXISTS skill_weights jsonb;

COMMENT ON COLUMN projects.skill_weights IS
  '必須スキルごとの重み {"Java":6,"基本設計":1}。マッチングの必須スキル配点に使う。NULL なら全て等価';

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer);

CREATE FUNCTION public.fetch_candidates_for_project(
  p_data_env          text,
  p_required_skills   text[]  DEFAULT NULL,
  p_budget_min        numeric DEFAULT NULL,
  p_budget_max        numeric DEFAULT NULL,
  p_work_location     text    DEFAULT NULL,
  p_remote_policy     text    DEFAULT NULL,
  p_limit             integer DEFAULT 500,
  p_weight_skill      integer DEFAULT 40,
  p_weight_exp        integer DEFAULT 15,
  p_weight_rate       integer DEFAULT 15,
  p_weight_location   integer DEFAULT 20,
  p_weight_remote     integer DEFAULT 10,
  p_require_haken     boolean DEFAULT false,
  p_work_prefecture   text    DEFAULT NULL,
  p_required_exp_years integer DEFAULT NULL,
  p_skill_weights     jsonb   DEFAULT NULL
)
RETURNS SETOF candidates_lite
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_skills          text[];
  v_skills_len      int;
  v_total_weight    numeric;
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

  -- 必須スキル全体の重み合計。skill_weights のキーは元の表記なので小文字で突き合わせる
  SELECT COALESCE(SUM(
           COALESCE((SELECT GREATEST(e.value::numeric, 0)
                       FROM jsonb_each_text(COALESCE(p_skill_weights, '{}'::jsonb)) e
                      WHERE lower(e.key) = q), 1)
         ), 0)
    INTO v_total_weight
    FROM unnest(COALESCE(v_skills, ARRAY[]::text[])) q;

  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';
  v_project_has_remote := v_is_full_remote OR COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅';
  v_loc_lower := lower(trim(COALESCE(p_work_location, '')));

  -- 正規化済みの work_prefecture があればそれを正とする。
  -- 無いときだけ従来どおり work_location の文字列から切り出す（後方互換）
  IF COALESCE(trim(p_work_prefecture), '') != '' THEN
    v_work_pref_core := COALESCE(
      (regexp_match(p_work_prefecture, '(\S+?)[都道府県]'))[1],
      trim(p_work_prefecture)
    );
  ELSE
    v_work_pref_core := COALESCE(
      (regexp_match(p_work_location, '(\S+?)[都道府県]'))[1],
      regexp_replace(
        split_part(trim(COALESCE(p_work_location, '')), ' ', 1),
        '(市|区|町|村|郡).*$', ''
      )
    );
  END IF;
  v_work_region := get_region(v_work_pref_core);

  RETURN QUERY
  WITH req AS (
    -- 必須スキルと、その重み（skill_weights に無いものは1）
    SELECT q AS name,
           COALESCE((SELECT GREATEST(e.value::numeric, 0)
                       FROM jsonb_each_text(COALESCE(p_skill_weights, '{}'::jsonb)) e
                      WHERE lower(e.key) = q), 1) AS w
      FROM unnest(COALESCE(v_skills, ARRAY[]::text[])) q
  ),
  pre AS (
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
      -- 満たせた必須スキルの重み合計（候補者側の件数ではなく必須側の充足で数える）
      (SELECT COALESCE(SUM(r.w), 0)
         FROM req r
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.skills) s
           WHERE lower(s) LIKE '%' || r.name || '%' OR r.name LIKE '%' || lower(s) || '%'
        )) AS hit_w
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
            WHEN v_skills_len = 0 OR v_total_weight = 0 THEN 20.0/40.0
            WHEN pre.hit_w = 0                          THEN 0.0
            ELSE LEAST(pre.hit_w / v_total_weight, 1.0)
          END * p_weight_skill)
        + ROUND(CASE
            -- 案件が必要年数を明示している場合は「要件を満たすか」で採点する
            WHEN p_required_exp_years IS NOT NULL AND p_required_exp_years > 0 THEN
              CASE
                WHEN c.experience_years IS NULL                              THEN 8.0/15.0
                WHEN c.experience_years >= p_required_exp_years              THEN 1.0
                WHEN c.experience_years >= p_required_exp_years - 1          THEN 8.0/15.0
                WHEN c.experience_years >= p_required_exp_years - 2          THEN 4.0/15.0
                ELSE 0.0
              END
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
            WHEN COALESCE(v_work_pref_core, '') = '' THEN 5.0/20.0
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
    AND (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$function$;
