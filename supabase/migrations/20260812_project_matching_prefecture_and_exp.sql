-- 案件側の抽出をマッチングに効く形にする（2026-08-12）
--
-- 背景: fetch_candidates_for_project のルールスコアで案件側が持ち込める情報は
--   required_skills(40) / budget_max(15) / work_location(20) / remote_policy(10) の4つだけで、
--   経験年数(15)は候補者の値だけを見ていた。実データ監査で2つの穴が判明した。
--
--   ① 勤務地の非対称: 人材側は station_master で都道府県に正規化済みだが、案件側は生文字列のまま。
--      RPC は work_location を `(\S+?)[都道府県]` で切るため「東品川（最寄りは青物横丁…）」型は
--      都道府県が取れず、重み20が丸ごと0点になっていた。
--   ② 経験年数が片側採点: 案件に必要経験年数の受け皿が無く「10年以上=満点」の絶対評価だった。
--      3年で足りる案件でもベテランが上位に来る。
--
-- 対応:
--   - projects に work_prefecture / required_experience_years を追加（抽出時に埋める）
--   - RPC に p_work_prefecture / p_required_exp_years を追加。
--     いずれも NULL のときは従来と同じ挙動（後方互換）

ALTER TABLE projects ADD COLUMN IF NOT EXISTS work_prefecture text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS required_experience_years integer;

COMMENT ON COLUMN projects.work_prefecture IS
  '勤務地から解決した都道府県（例: 東京都）。work_location は表示用の生文字列のまま残し、マッチングはこちらを使う';
COMMENT ON COLUMN projects.required_experience_years IS
  '募集要件の必要経験年数（例: 「実務経験5年以上」→ 5）。NULL は要件記載なし';

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean);

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
  p_required_exp_years integer DEFAULT NULL
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
            -- 案件が必要年数を明示している場合は「要件を満たすか」で採点する。
            -- 絶対評価のままだと3年で足りる案件でもベテランが機械的に上位へ来るため
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
    AND (v_skills IS NULL OR v_skills_len = 0 OR pre.hits > 0)
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$function$;
