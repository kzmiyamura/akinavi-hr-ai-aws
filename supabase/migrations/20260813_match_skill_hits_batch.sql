-- 候補者バッチ×必須スキルの充足判定を1往復で返す。
--
-- 2026-08-12 にスキル一致判定を skill_satisfies に集約したが、match-batch Edge Function は
-- 自前の双方向部分一致（`have.includes(want) || want.includes(have)` で +0.5）のまま残っていた。
-- そのため画面の「スコア内訳」だけ旧ルールで、実害が出ていた（2026-08-13）:
--   必須 = 基本設計 / Microsoft 365 / PowerShell / EntraID / Azure Functions
--   候補者 = 基本設計・C・Shell ほか
--   → 基本設計=1、Shell が PowerShell に+0.5、C が Microsoft 365 と Azure Functions に
--      それぞれ +0.5 で「必須5中3合致」。目視では1つしか合っていない。
--
-- match_skill_strings は1人分（have[] × want[]）なので、20人バッチで20往復になる。
-- ここではバッチ全体を1回で受けて「誰のどの必須スキルが充足したか」を返す。
-- 英語レベルによる重み付けは呼び出し側（TS）が行うため、件数ではなく組を返す。
--
-- p_haves: 候補者ごとのスキル配列の配列。例 '[["Java","SQL"],["C","Shell"]]'
-- 戻り: idx = p_haves 内での候補者の位置（0始まり）、want = 充足した必須スキル

CREATE OR REPLACE FUNCTION public.match_skill_hits_batch(
  p_haves jsonb,
  p_want  text[]
)
RETURNS TABLE(idx int, want text)
LANGUAGE sql STABLE
AS $$
  SELECT DISTINCT
         (c.ord - 1)::int AS idx,
         w                AS want
    FROM jsonb_array_elements(COALESCE(p_haves, '[]'::jsonb)) WITH ORDINALITY AS c(skills, ord)
    CROSS JOIN LATERAL jsonb_array_elements_text(c.skills) AS h(skill)
    CROSS JOIN unnest(COALESCE(p_want, ARRAY[]::text[])) AS w
   WHERE skill_satisfies(h.skill, w)
$$;

COMMENT ON FUNCTION public.match_skill_hits_batch(jsonb, text[]) IS
  '候補者バッチ×必須スキルのうち充足した組を返す。match-batch のルールスコア用（判定は skill_satisfies に一本化）';

GRANT EXECUTE ON FUNCTION public.match_skill_hits_batch(jsonb, text[]) TO anon, authenticated, service_role;
