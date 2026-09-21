-- ============================================================================
-- スキル別の単価相場（人材カードに「相場と比べて高いか安いか」を出すため）
-- ============================================================================
-- 営業が単価交渉するとき、根拠になるのは「同じスキル帯の相場」。
-- 今は人材の希望単価だけが出ていて、それが高いのか安いのか画面から分からない。
--
-- 実測（2026-09-21・ローカル控え4,324人）:
--   全体の希望単価  中央値70万 / 下位25% 60万 / 上位25% 83万
--   高い: PMP 102.5万 / SRE 95万 / ゼロトラスト 95万 / AWS CDK 90万
--   多い: テスト2,831人 / 要件定義2,636人 / Java1,913人（いずれも70万前後）
--
-- ⚠ 人数が少ないスキルの「相場」は相場ではない。20人以上に限る。
-- ⚠ 画面から candidates を引かせない。ビューで畳んで返す（CLAUDE.md の egress 鉄則）。
-- ============================================================================

CREATE OR REPLACE VIEW public.skill_rate_market AS
WITH base AS (
  SELECT
    s.skill,
    parse_rate_man(c.desired_rate) AS rate
  FROM public.candidates c,
       LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(c.skills) = 'array' THEN c.skills ELSE '[]'::jsonb END
       ) AS s(skill)
  WHERE c.data_env = 'prod'
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
)
SELECT
  skill,
  count(*)                                              AS people,
  count(rate)                                           AS with_rate,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY rate)::numeric, 0) AS p25,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY rate)::numeric, 0) AS median,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate)::numeric, 0) AS p75
FROM base
GROUP BY skill
-- 20人未満は相場と言えない。人数が少ないと1人の極端な希望に引きずられる
HAVING count(rate) >= 20;

COMMENT ON VIEW public.skill_rate_market IS
  'スキル別の希望単価相場（万円・中央値と四分位）。単価交渉の根拠として人材カードに出す。20人以上のスキルだけ';

GRANT SELECT ON public.skill_rate_market TO anon, authenticated;
