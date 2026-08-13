-- fetch_candidates_for_project の高速化
--
-- 背景:
--   anon ロールの statement_timeout（既定8秒）に対して本関数は実測7.3秒かかっており、
--   必須スキルが広い案件（SQL・テスト・基本設計 など充足1,000人超）では毎回
--   「canceling statement due to statement timeout」で落ちていた。
--   その結果マッチング画面の「再実行」が open 8案件中5案件で常に失敗し、
--   保存済みスコアが古いまま残っていた（2026-08-13 発見）。
--
--   関数の先頭に PERFORM set_config('statement_timeout','30000',true) があるが、
--   statement_timeout のタイマーは文の開始時に決まるため、実行中の文には効かない。
--   CLI（superuser・既定30秒）で測ると通るので余裕があるように見えていた。
--
-- 遅かった理由:
--   candidates_lite は (raw_profile - 'text' - 'parsedGrid') を行ごとに評価するビュー。
--   raw_profile は1件約35KBあり、TOAST の解凍と jsonb の作り直しが行ごとに走る。
--   旧実装はこのビューを
--     ① pre CTE（絞り込み用）
--     ② 最終 SELECT（返却用。ORDER BY / LIMIT より前に全該当者を展開）
--   の2回スキャンしていた。必須スキルが広いと該当1,500人超 × 2回になる。
--   実測の内訳は skill_hit_weights が 0.77秒、残り約6.5秒がこれ。
--
-- 変更点（判定・配点は一切変えない。スキャンの順序だけを変える）:
--   1. スコア計算に使う項目（prefecture / desiredRate / wantsFullRemote /
--      remoteAvailable / from）は pre で base テーブルから1回だけ取り出す。
--      以降のスコア式は raw_profile を触らない
--   2. 並べ替えと LIMIT を id だけで先に済ませる
--   3. candidates_lite は最後に、返す p_limit 件に対してだけ結合する
--
-- 配点を変えていないことは scripts/sql/test_fetch_candidates_parity.sql で確認する。

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);

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
BEGIN
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
  WITH hw AS MATERIALIZED (
    -- 必須スキルの充足はここに集約している（auto-match も同じ関数を呼ぶ）
    SELECT candidate_id, hit_w
      FROM skill_hit_weights(p_data_env, p_required_skills, p_skill_weights)
  ),
  pre AS MATERIALIZED (
    -- raw_profile を読むのはここだけ。以降のスコア式はこの列を使う
    SELECT
      c.id,
      c.created_at,
      c.experience_years,
      COALESCE(
        (regexp_match(c.raw_profile->>'prefecture', '(\S+?)[都道府県]'))[1],
        regexp_replace(
          split_part(trim(COALESCE(c.raw_profile->>'prefecture', '')), ' ', 1),
          '(市|区|町|村|郡).*$', ''
        )
      ) AS pref_core,
      COALESCE(c.raw_profile->>'prefecture', '')            AS pref_raw,
      (c.raw_profile->>'wantsFullRemote')::boolean          AS wants_full_remote,
      (c.raw_profile->>'remoteAvailable')::boolean          AS remote_available,
      (c.raw_profile->>'remoteAvailable') IS NULL           AS remote_unknown,
      NULLIF(REGEXP_REPLACE(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, ''), '[^0-9.]', '', 'g'), '')::numeric AS rate_val,
      COALESCE(hw.hit_w, 0) AS hit_w
    FROM candidates c
    LEFT JOIN hw ON hw.candidate_id = c.id
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
  ),
  scored AS (
    SELECT
      pre.id,
      pre.created_at,
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
                WHEN pre.experience_years IS NULL                        THEN 8.0/15.0
                WHEN pre.experience_years >= p_required_exp_years        THEN 1.0
                WHEN pre.experience_years >= p_required_exp_years - 1    THEN 8.0/15.0
                WHEN pre.experience_years >= p_required_exp_years - 2    THEN 4.0/15.0
                ELSE 0.0
              END
            WHEN pre.experience_years IS NULL THEN 8.0/15.0
            WHEN pre.experience_years >= 10   THEN 1.0
            WHEN pre.experience_years >= 7    THEN 12.0/15.0
            WHEN pre.experience_years >= 5    THEN 8.0/15.0
            WHEN pre.experience_years >= 3    THEN 4.0/15.0
            WHEN pre.experience_years >= 1    THEN 2.0/15.0
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
            WHEN pre.pref_raw = ''  THEN 5.0/20.0
            WHEN pre.pref_core != ''
                 AND v_work_pref_core != ''
                 AND pre.pref_core = v_work_pref_core              THEN 1.0
            WHEN pre.pref_core != ''
                 AND v_work_region IS NOT NULL
                 AND get_region(pre.pref_core) = v_work_region  THEN 0.5
            ELSE 0.0
          END * p_weight_location)
        + ROUND(CASE
            WHEN pre.wants_full_remote = true
                 AND NOT v_project_has_remote                       THEN -1.0
            WHEN v_is_full_remote                                   THEN 0.0
            WHEN pre.remote_available = true
                 AND COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅' THEN 1.0
            WHEN pre.remote_unknown                                 THEN 0.5
            ELSE 0.0
          END * p_weight_remote)
      ) AS rule_score
    FROM pre
    WHERE (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)
  ),
  top AS (
    -- 重い candidates_lite に触る前に、返す件数まで絞る
    SELECT id, rule_score, created_at
      FROM scored
     ORDER BY rule_score DESC, created_at DESC
     LIMIT p_limit
  )
  SELECT c.*
    FROM candidates_lite c
    JOIN top ON top.id = c.id
   ORDER BY top.rule_score DESC, top.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fetch_candidates_for_project(
  text, text[], numeric, numeric, text, text, integer, integer, integer,
  integer, integer, integer, boolean, text, integer, jsonb
) TO anon, authenticated;
