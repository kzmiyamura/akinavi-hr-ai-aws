-- 自動生成: scripts/gen_fetch_candidates_role.py
-- 入力: supabase/migrations/20260813_fetch_candidates_selective.sql
--
-- fetch_candidates_for_project に「案件が求める役割」との合致度を足す。
--
-- 背景（2026-08-14）:
--   人材側は raw_profile.roles に主役割を持っていたのに、案件側に要求役割が無く
--   採点に使われていなかった。PMO歴10年の人が実装案件の1位（95点）になっていた。
--   案件側の requiredRole は AI解釈が入れる（単語一致では取れないため）。
--
-- 加減点はゲートではない（ユーザー判断「他と一緒でうまく点数付けしたらいい」）:
--   同一役割 +15 / 同系統 +6 / 不明 0 / 系統違い -9（p_weight_role=30 のとき）
--   requiredRole が NULL の案件は必ず 0 なので、既存の順位は一切動かない。
--
-- ⚠ この関数は手で書き写さないこと。直すときはこの生成スクリプトを使う。

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb, text[]);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer);

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
  p_skill_weights     jsonb   DEFAULT NULL,
  -- 尚可（歓迎）スキル。必須の分母は増やさず、スキル比率に最大 +10% だけ乗せる
  -- （match-batch の niceToHaveSkills と同じ扱い）
  p_nice_skills       text[]  DEFAULT NULL,
  -- 案件が求める役割（AI解釈 raw_data.aiInterpretation.requiredRole）。
  -- 人材側の raw_profile.roles[0]（主役割）と role_affinity で突き合わせる。
  -- NULL なら加減点ゼロ＝この機能を入れる前と同じ順位になる
  p_required_role     text    DEFAULT NULL,
  p_weight_role       integer DEFAULT 30
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
  v_nice_len        int;
  v_sel_skills      text[];
  v_has_generic     boolean;
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

  SELECT COUNT(*)
    INTO v_nice_len
    FROM unnest(COALESCE(p_nice_skills, ARRAY[]::text[])) x
   WHERE trim(x) != '';

  -- 汎用スキル（skill_master.is_generic）を除いた必須スキル。
  -- 「基本設計」だけ合致した人を候補に残さないために使う。配点には影響しない
  v_sel_skills  := selective_skills(p_required_skills);
  v_has_generic := v_skills_len > 0
                   AND COALESCE(array_length(v_sel_skills, 1), 0) < v_skills_len;

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
  sel AS MATERIALIZED (
    -- 汎用スキルを除いた必須スキルの充足。絞り込みにだけ使い、点数には入れない。
    -- 汎用が混ざっていない案件では呼ばない（NULL を渡すと空集合が返る）
    SELECT candidate_id
      FROM skill_hit_weights(p_data_env,
                             CASE WHEN v_has_generic THEN v_sel_skills END,
                             NULL)
  ),
  nice AS MATERIALIZED (
    -- 尚可スキルの充足数。判定は必須と同じ skill_hit_weights（skill_satisfies）。
    -- 重みを渡さないので1件1点になる。尚可が無いときは空集合で済ませる
    SELECT candidate_id, hit_w AS nice_w
      FROM skill_hit_weights(p_data_env,
                             CASE WHEN v_nice_len > 0 THEN p_nice_skills END,
                             NULL)
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
      (c.raw_profile->>'hakenOk')::boolean                  AS haken_ok,
      COALESCE(nice.nice_w, 0) AS nice_w,
      (sel.candidate_id IS NOT NULL) AS sel_ok
      ,c.raw_profile->'roles'->>0 AS main_role
    FROM candidates c
    LEFT JOIN hw ON hw.candidate_id = c.id
    LEFT JOIN nice ON nice.candidate_id = c.id
    LEFT JOIN sel ON sel.candidate_id = c.id
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
        ROUND(LEAST(
            CASE
              WHEN v_skills_len = 0 OR v_total_weight = 0 THEN 20.0/40.0
              WHEN pre.hit_w = 0                          THEN 0.0
              ELSE LEAST(pre.hit_w / v_total_weight, 1.0)
            END
            -- 尚可スキルの加点（最大 +10%）。分母は尚可の件数で、必須には影響しない
            + CASE WHEN v_nice_len > 0
                   THEN LEAST(pre.nice_w / v_nice_len, 1.0) * 0.1
                   ELSE 0 END
          , 1.0) * p_weight_skill)
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
      -- 役割の合致度（2026-08-14）。実装案件のPMO・PM案件のPG を沈める。
      -- ゲートではなく加減点。中立(0.5)＝0 なので requiredRole 未設定なら無影響
      + ROUND((role_affinity(p_required_role, pre.main_role) - 0.5) * p_weight_role)
      AS rule_score_raw
    FROM pre
    WHERE (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)
      -- 汎用スキル（テスト・基本設計 等、全人材の4割超が持つもの）だけの合致では
      -- 候補にしない。PowerShell 案件の上位20人中4人が PowerShell も
      -- Azure Functions も持たず「基本設計」だけで入っていた（2026-08-13 実測）。
      -- 必須が汎用スキルだけの案件では selective_skills が元の配列を返すので
      -- v_has_generic が false になり、この条件は効かない
      AND (NOT v_has_generic OR pre.sel_ok)
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
  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer
) TO anon, authenticated;
