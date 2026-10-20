-- 自動生成: scripts/gen_fetch_candidates_offerable_gate.py
-- 入力: supabase/migrations/20261012_2_fetch_candidates_location_gate.sql
--
-- fetch_candidates_for_project に「今うちから出せる人だけ」の縛りを足す。
--
-- 背景（2026-10-20 営業の指示「ボタンをおけ」）:
--   公開15案件の上位5人（75人）のうち、自社or1社先×経歴書あり×すぐ稼働 を
--   全部満たす人は **20人(27%)**。出せる人が1人もいない案件が3件。
--   採点式（スキル・経験・単価・勤務地・リモート）にこの3つは入っていないので、
--   重みをいくら動かしても直らない。人材マップで絞れる3条件と同じものを、
--   勤務地の縛りと同じ**前提条件**にする。既定 ON、画面のスイッチで切れる。
--   ⚠ top_match_marks（人材一覧の「上位候補」印）もこの関数を呼ぶので、
--      印も「出せる人の上位」になる。適用後に refresh_top_match_marks を1回呼ぶこと。
--
-- ⚠ この関数は手で書き写さないこと。直すときはこの生成スクリプトを使う。

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb, text[]);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean);
DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean);

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
  p_weight_role       integer DEFAULT 30,
  -- 勤務地の縛り（2026-10-12）。true で「地方が違う人」を候補から外す。
  -- フルリモート案件・案件の都道府県が取れていない案件では効かない。
  -- 既定を true にしているのは、通えない人を並べても営業が使えないため。
  -- 画面から false にすると従来どおり全員を点数で並べる
  p_location_gate     boolean DEFAULT true,
  -- 今うちから出せる人だけ（2026-10-20）。自社or1社先 × 経歴書あり × 稼働が今日以前。
  -- 未取得は通さない（人材マップの絞りと同じ）。既定 true なのは、上位5人のうち
  -- 出せる人が27%しかいなかったため（本番実測）。画面から false にすると従来どおり
  p_offerable_only    boolean DEFAULT true
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
  -- 正規化済みの work_prefecture を正とし、無いときだけ work_location から切り出す。
  -- 判定は work_pref_core / extract_pref_core に1つだけ置く（2026-10-12）
  v_work_pref_core := work_pref_core(p_work_prefecture, p_work_location);
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
      -- 「京都府」→「京」・「北海道」→「北海」と壊れていたため共有関数に寄せた（2026-10-12）
      extract_pref_core(c.raw_profile->>'prefecture') AS pref_core,
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
      -- 出せる人の判定に使う3列（2026-10-20）。式は offerable_ok に置き、ここでは値だけ取る
      ,c.raw_profile->>'commercialFlow' AS flow_raw
      ,(c.resume_url IS NOT NULL OR c.drive_url IS NOT NULL OR c.box_url IS NOT NULL) AS has_resume
      ,parse_available_from(c.raw_profile->>'availableFrom') AS avail_date
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
      -- 勤務地の縛り（2026-10-12 ユーザー判断「フルリモートでない限り勤務地縛り100」）。
      -- 勤務地は配点ではなく前提条件。通えない人は候補に入れない。
      --
      -- 実測（prod 1,915人・2026-10-12）:
      --   大阪府在住  40人（2.1%）／関西の他県 24人／居住地不明 64人（3.3%）
      --   関西外    1,787人（93.3%）
      -- 大阪の案件（販売管理・淀屋橋）では C#.NET を満たす514人のうち
      -- 大阪14・関西他9・不明3 に対し**関西外が488人**で、上位10人を過ぎると
      -- 以降は全員が通えない人だった。順位は正しくても一覧の95%が使えない。
      --
      -- 落とすのは「地方が違う」人だけ:
      --   ・同一県            … 残す（満点）
      --   ・同一地方          … 残す（淀屋橋に兵庫・京都から通うのは普通）
      --   ・居住地が取れていない … 残す（3.3%。取れていない＝通えないではない）
      --   ・フルリモート案件   … 縛らない
      --   ・案件の都道府県が不明 … 縛らない（比べる相手が無い）
      --
      -- ⚠ 「不明」の判定に空文字を使ってはいけない。案件の勤務地が
      --   『客先（詳細は面談時）』のように県名を含まないとき、v_work_pref_core には
      --   **その文字列がそのまま入る**（空にはならない）。空だけを見ていると
      --   どの県とも一致せず**候補が全員消える**（居住地不明の3人だけが残った）。
      --   get_region() は47都道府県を網羅しているので、NULL なら県として
      --   成立していない＝縛る相手が無い、と判定する。
      --   prod の案件15件は現在すべて県が取れているが、取れない案件は必ず来る。
      --   以前は勤務地が全員0点になるだけで害が無かったが、ゲートにすると空になる
      -- 人材側の「稼働可能地域」(raw_profile.availableRegions) は AI 全廃で
      -- 埋まらなくなっており、実質すべて null なので判定には使えない。
      -- 関東在住で大阪常駐が可能な人を残したいときは p_location_gate=false にする
      -- 条件そのものは location_gate_ok に1つだけ置く（20261012_1_location_gate_shared.sql）。
      -- auto-match のように自前で候補集合を作る経路も同じ関数を呼べるようにするため、
      -- ここに条件をコピーしない
      AND location_gate_ok(p_location_gate, v_is_full_remote,
                           v_work_pref_core, pre.pref_raw, pre.pref_core)
      -- 今うちから出せる人だけ（2026-10-20 営業の指示「ボタンをおけ」）。
      -- 本番実測: 公開15案件の上位5人（75人）のうち、すぐ稼働 24・来月以降 25・
      -- 読めない 26。3つ全部OK は 20人(27%)。出せる人が1人もいない案件が3件。
      -- 採点式には所属・経歴書・稼働が入っていないので、重みでは直らない。
      -- 条件そのものは offerable_ok に1つだけ置く（20261020_4_offerable_gate_shared.sql）
      AND offerable_ok(p_offerable_only, pre.flow_raw, pre.has_resume, pre.avail_date)
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
  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean
) TO anon, authenticated;
