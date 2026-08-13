-- fetch_candidates_for_project を順位付けと表示スコアで揃える（2026-08-13）
--
-- 画面に出るスコアは match-batch が計算し、候補者の絞り込みと順位付けはこの関数が行う。
-- 両者の配点が揃っておらず「順位は上なのにスコアが低い」「数が合わない」が起きていた。
-- ここでは順位付け側に残っていた次の食い違いを潰す。
--
-- ① 希望単価の読み取りが壊れていた（最重要）
--    REGEXP_REPLACE(desiredRate,'[^0-9.]','','g') は数字以外を消して**連結**するため、
--    「55万円以上希望（PMOなどは67万円）」→ 5567、「80万（140～180h）」→ 80140180 になり、
--    予算超過扱いで単価が 0点になっていた。parse_rate_wan で「万」単位の金額だけを読み、
--    複数あるときは最大値を採る（条件次第の高い方で予算超過を判定する）
-- ② 派遣案件の加減点が順位に入っていなかった
--    match-batch は「派遣NG→20pt上限」「常駐可→+5pt」を掛けているのに、順位側は無視。
--    p_contract_type を受け取って同じ扱いにする
--
-- 配点そのもの（スキル・経験・勤務地・リモートの各係数）は変更していない。

-- 「万」単位の希望単価を読む。複数あるときは最大値。
-- match-batch の parseRateWan と同じ規則にすること（片方だけ直すと順位と表示がズレる）。
CREATE OR REPLACE FUNCTION public.parse_rate_wan(p_text text)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(
    (SELECT MAX((m[1])::numeric)
       FROM regexp_matches(COALESCE(p_text, ''), '(\d+(?:\.\d+)?)\s*万', 'g') m
      WHERE (m[1])::numeric > 0 AND (m[1])::numeric <= 500),
    -- 「万」が付かない純粋な数値（desired_rate 列の値など）はそのまま採る
    (CASE WHEN COALESCE(p_text, '') ~ '^\s*\d+(\.\d+)?\s*$'
          THEN trim(p_text)::numeric END)
  )
$$;

COMMENT ON FUNCTION public.parse_rate_wan(text) IS
  '希望単価文字列から万単位の金額を読む。複数あれば最大値。match-batch の parseRateWan と対';

GRANT EXECUTE ON FUNCTION public.parse_rate_wan(text) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb);

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
  -- 案件の契約形態。'派遣' のとき人材側の hakenOk で加減点する（match-batch と同じ扱い）
  p_contract_type     text    DEFAULT NULL,
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
      parse_rate_wan(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, '')) AS rate_val,
      COALESCE(hw.hit_w, 0) AS hit_w,
      (c.raw_profile->>'hakenOk')::boolean                  AS haken_ok
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
      pre.haken_ok,
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
      )
      -- 派遣案件の加減点。表示スコア（match-batch）にだけ入っていて順位に反映されず、
      -- 「派遣NGなのに上位」「常駐可なのに順位が上がらない」が起きていた（2026-08-13）
      + CASE WHEN p_contract_type = '派遣' AND pre.haken_ok = true THEN 5 ELSE 0 END
      AS rule_score_raw
    FROM pre
    WHERE (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)
  ),
  top AS (
    -- 重い candidates_lite に触る前に、返す件数まで絞る
    SELECT id,
           -- 派遣NGの人は派遣案件で 20pt 上限（match-batch と同じ）
           CASE WHEN p_contract_type = '派遣' AND haken_ok = false
                THEN LEAST(rule_score_raw, 20) ELSE LEAST(rule_score_raw, 100) END AS rule_score,
           created_at
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
  integer, integer, integer, boolean, text, text, integer, jsonb
) TO anon, authenticated;
