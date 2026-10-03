-- ============================================================================
-- 単価相場に「経験年数」を効かせる
-- ============================================================================
-- 2026-10-03 の指摘:
--   23歳・経験ほぼ無しの人材（VMware・希望50万）に「相場75万（VMware）-25」と出ていた。
--   「相場より低いというより、年齢でその金額行くか？」
--
-- 原因: skill_rate_market はスキル単位でしか相場を持たず、**20年選手の中央値**と
--       比べていた。若手が安く見えるのは当たり前で、営業の判断材料にならない。
--
-- 実測（ローカル控え・prod 7,659人。egress ゼロ）:
--
--   経験          人数   25%   中央   75%        VMware だけ（722人）
--   0〜2年          293    45    53    65          23人  46  57  60
--   3〜5年         1154    55    63    70          55人  55  65  70
--   6〜10年        1787    60    70    78         110人  61  70  80
--   11〜15年        982    60    74    85         104人  68  80  90
--   16年以上       3443    65    75    88         430人  70  81  90
--
--   → VMware 0〜2年の中央値は **57万**。50万は -7万で、25〜75%（46〜60）の中。
--      「-25」は実態と違う。
--
-- スキル×帯に割っても **1,427セット**が20人以上に届く（0〜2年でも102スキル）。
-- 帯で割っても相場と呼べる人数は残るので、スキル×帯を正とする。
-- 届かないセルは帯だけの相場（exp_rate_market・5行）に落とす。
--
-- ⚠ 人数が少ないセルの「相場」は相場ではない。20人以上に限る（既存の方針と同じ）。
-- ⚠ 画面から candidates を引かせない。ビューで畳んで返す（CLAUDE.md の egress 鉄則）。
-- ============================================================================

-- 経験年数 → 帯。IT の単価が実際に段差になる所に合わせた。
-- ⚠ 画面側（src/lib/db/skillRateMarket.ts の expBand）と**同じ切り方**にすること。
--    片方だけ変えると、画面が引くキーとビューのキーが食い違って相場が出なくなる。
CREATE OR REPLACE FUNCTION public.exp_band(years numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN years IS NULL   THEN NULL
    WHEN years <  3      THEN '0-2'
    WHEN years <  6      THEN '3-5'
    WHEN years < 11      THEN '6-10'
    WHEN years < 16      THEN '11-15'
    ELSE                      '16+'
  END
$$;

COMMENT ON FUNCTION public.exp_band(numeric) IS
  '経験年数を単価の段差に合わせた帯に畳む。画面側 expBand と同じ切り方を保つこと';

-- ── スキル × 経験帯 ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.skill_rate_market_by_exp AS
WITH base AS (
  SELECT
    s.skill,
    public.exp_band(c.experience_years) AS exp_band,
    parse_rate_man(c.desired_rate)      AS rate
  FROM public.candidates c,
       LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(c.skills) = 'array' THEN c.skills ELSE '[]'::jsonb END
       ) AS s(skill)
  WHERE c.data_env = 'prod'
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
    AND c.experience_years IS NOT NULL
)
SELECT
  skill,
  exp_band,
  count(*)                                                             AS people,
  count(rate)                                                          AS with_rate,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY rate)::numeric, 0) AS p25,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY rate)::numeric, 0) AS median,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate)::numeric, 0) AS p75
FROM base
WHERE exp_band IS NOT NULL
GROUP BY skill, exp_band
HAVING count(rate) >= 20;

COMMENT ON VIEW public.skill_rate_market_by_exp IS
  'スキル×経験帯ごとの希望単価相場（万円）。20人以上のセットだけ。相場比較の第一基準';

-- ── 経験帯だけ（スキル×帯が薄いときの受け皿・5行） ──────────────────────
CREATE OR REPLACE VIEW public.exp_rate_market AS
WITH base AS (
  SELECT
    public.exp_band(c.experience_years) AS exp_band,
    parse_rate_man(c.desired_rate)      AS rate
  FROM public.candidates c
  WHERE c.data_env = 'prod'
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
    AND c.experience_years IS NOT NULL
)
SELECT
  exp_band,
  count(*)                                                             AS people,
  count(rate)                                                          AS with_rate,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY rate)::numeric, 0) AS p25,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY rate)::numeric, 0) AS median,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate)::numeric, 0) AS p75
FROM base
WHERE exp_band IS NOT NULL
GROUP BY exp_band
HAVING count(rate) >= 20;

COMMENT ON VIEW public.exp_rate_market IS
  '経験帯ごとの希望単価相場（万円・全スキル込み）。スキル×帯が20人に届かないときの受け皿';

GRANT SELECT ON public.skill_rate_market_by_exp TO anon, authenticated;
GRANT SELECT ON public.exp_rate_market          TO anon, authenticated;
