-- 「誰でも持っているスキル」に印を付ける（2026-08-13）
--
-- 背景:
--   案件の必須スキルに「基本設計」「テスト」のような工程の呼び名が入っている。
--   これらは全人材の半分以上が持っているため、必須スキルに入れても誰も落とせない。
--   実測（prod・open案件）:
--     化成品案件      候補1,468人のうち 632人(43%) が「基本設計」だけで残っていた
--     PowerShell案件  上位20人のうち 4人(20%) が PowerShell も Azure Functions も
--                     Microsoft 365 も EntraID も持たず「基本設計」だけで上位にいた
--   高速モードは上位20件しか AI 採点しないので、この4人は営業の目に直接入る枠を潰している。
--
-- 「工程語かどうか」では切らない:
--   同じ methodologies カテゴリでも「保守開発」は94人、「ヘルプデスク」は248人しかおらず、
--   立派な絞り込みになっている。逆に「テスト」は1,486人（8割）が該当する。
--   問題なのは工程の呼び名であることではなく、**充足率が高すぎて選別に使えない**こと。
--
-- 充足率だけでも切れない:
--   しきい値40%で測ったら Java(47.6%)・SQL(77.3%) まで汎用に落ちた。
--   Java 案件で Java しか合致しない人を落とすのは明らかに誤り。技術名は充足率が高くても
--   選別に使える（その言語ができる人を探しているのだから）。
--   そこで **skill_master.category が技術名でない（methodologies / others）** かつ
--   **充足率がしきい値以上** の両方を満たすものだけを汎用とする。
--   これで テスト(74%)・基本設計(58%) は落ち、保守開発(5%)・ヘルプデスク(13%) は残る。
--
-- 使い方:
--   SELECT refresh_generic_skills();       -- 既定のしきい値40%で貼り直す
--   SELECT refresh_generic_skills(0.5);    -- しきい値を変える
--   人材が増えると充足率は動くので、skill_norm_map と同じタイミングで貼り直すこと。

ALTER TABLE skill_master
  ADD COLUMN IF NOT EXISTS is_generic boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN skill_master.is_generic IS
  '全人材のうち充足率がしきい値を超えるスキル（基本設計・テスト等）。'
  '単独では候補資格にならない。refresh_generic_skills() が貼る';

-- 案件の必須スキルに実際に出てくるものだけを測る。
-- skill_master 全951件を測ると skill_hit_weights を951回呼ぶことになり現実的でない。
-- 戻り値の形を変えたので作り直す（CREATE OR REPLACE では列を足せない）
DROP FUNCTION IF EXISTS public.refresh_generic_skills(numeric);

CREATE FUNCTION public.refresh_generic_skills(p_threshold numeric DEFAULT 0.40)
RETURNS TABLE(スキル text, 分類 text, 充足人数 bigint, 充足率 numeric, 汎用 boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_total bigint;
  r record;
  v_hit bigint;
  v_ratio numeric;
BEGIN
  SELECT COUNT(*) INTO v_total
    FROM candidates
   WHERE data_env = 'prod' AND merged_into IS NULL AND duplicate_flag = false;
  IF v_total = 0 THEN RETURN; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _gen_result(
    name text, cat text, hit bigint, ratio numeric, generic boolean
  ) ON COMMIT DROP;
  DELETE FROM _gen_result;

  FOR r IN
    SELECT DISTINCT s AS name
      FROM projects p, jsonb_array_elements_text(p.required_skills) s
     WHERE p.data_env = 'prod'
       AND jsonb_array_length(COALESCE(p.required_skills, '[]'::jsonb)) > 0
  LOOP
    SELECT COUNT(*) INTO v_hit FROM skill_hit_weights('prod', ARRAY[r.name], NULL);
    v_ratio := v_hit::numeric / v_total;
    INSERT INTO _gen_result
    SELECT r.name,
           m.category,
           v_hit,
           v_ratio,
           -- 技術名でない分類のものだけを汎用にする（Java・SQL を巻き込まないため）
           COALESCE(m.category IN ('methodologies', 'others'), false) AND v_ratio >= p_threshold
      FROM (SELECT 1) z
      LEFT JOIN skill_master m ON lower(trim(m.name)) = lower(trim(r.name));
  END LOOP;

  -- 印は skill_master の既存行に付ける。新しい行は作らない
  -- （新規行を作ると canon を奪ってスキル一致が壊れる。2026-08-13 に EntraID で実害）
  UPDATE skill_master m
     SET is_generic = g.generic
    FROM _gen_result g
   WHERE lower(trim(m.name)) = lower(trim(g.name))
     AND m.is_generic IS DISTINCT FROM g.generic;

  RETURN QUERY
    SELECT g.name, g.cat, g.hit, ROUND(g.ratio, 3), g.generic
      FROM _gen_result g
     ORDER BY g.ratio DESC;
END $$;

COMMENT ON FUNCTION public.refresh_generic_skills(numeric) IS
  '案件の必須スキルに出てくるスキルの充足率を測り、しきい値超を skill_master.is_generic に貼る';

GRANT EXECUTE ON FUNCTION public.refresh_generic_skills(numeric) TO service_role;

-- 必須スキル配列のうち「単独では候補資格にならない」ものを除いた配列を返す。
-- fetch_candidates_for_project と auto-match が同じ定義を使うためのヘルパー。
-- 必須が汎用スキルだけの案件では、空配列ではなく元の配列を返す（全員落とさない）。
CREATE OR REPLACE FUNCTION public.selective_skills(p_skills text[])
RETURNS text[]
LANGUAGE sql STABLE
AS $$
  WITH kept AS (
    SELECT s
      FROM unnest(COALESCE(p_skills, ARRAY[]::text[])) s
     WHERE NOT EXISTS (
       SELECT 1 FROM skill_master m
        WHERE m.is_generic
          AND lower(trim(m.name)) = lower(trim(s))
     )
  )
  SELECT CASE WHEN (SELECT COUNT(*) FROM kept) = 0
              THEN p_skills
              ELSE ARRAY(SELECT s FROM kept) END
$$;

COMMENT ON FUNCTION public.selective_skills(text[]) IS
  '必須スキルから汎用スキル（誰でも持っている）を除いた配列。'
  '全部が汎用なら元の配列をそのまま返す（候補が空になるのを防ぐ）';

GRANT EXECUTE ON FUNCTION public.selective_skills(text[]) TO anon, authenticated, service_role;
