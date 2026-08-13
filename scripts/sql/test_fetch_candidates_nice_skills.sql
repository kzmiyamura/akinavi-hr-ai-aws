-- fetch_candidates_for_project の尚可（歓迎）スキル加点の検証（2026-08-13）。
--
-- この関数は candidates_lite を返すだけで rule_score を列に出さない（順位が結果）。
-- そのため点数ではなく「順位がどう動いたか」で不変条件を確かめる。
--
-- 確認すること:
--   ① 尚可を渡しても候補者の顔ぶれが変わらない
--      ＝尚可だけ満たす人を新たに拾わない（絞り込み条件は据え置き）
--   ② 順位が上がったのは尚可を満たす人だけ
--   ③ 尚可を1つも満たさない人の順位は上がらない
--
-- p_limit は打ち切りで顔ぶれが変わるのを避けるため大きめに取る。
-- 実データ（prod）で測る。

WITH nice_hit AS (
  -- 尚可スキルの充足（判定は必須と同じ skill_satisfies）
  SELECT candidate_id, hit_w
    FROM skill_hit_weights('prod', ARRAY['AWS','Spring Boot'], NULL)
),
base AS (
  SELECT id, ROW_NUMBER() OVER () AS rk
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['Java','SQL']::text[], NULL::numeric, NULL::numeric,
      NULL::text, NULL::text, 3000, 40, 15, 15, 20, 10,
      false, NULL::text, NULL::text, NULL::integer, NULL::jsonb, NULL::text[])
),
withnice AS (
  SELECT id, ROW_NUMBER() OVER () AS rk
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['Java','SQL']::text[], NULL::numeric, NULL::numeric,
      NULL::text, NULL::text, 3000, 40, 15, 15, 20, 10,
      false, NULL::text, NULL::text, NULL::integer, NULL::jsonb,
      ARRAY['AWS','Spring Boot']::text[])
),
j AS (
  SELECT COALESCE(b.id, w.id) AS id,
         b.rk AS rk_base, w.rk AS rk_nice,
         COALESCE(n.hit_w, 0) AS nice_w
    FROM base b
    FULL OUTER JOIN withnice w ON w.id = b.id
    LEFT  JOIN nice_hit n ON n.candidate_id = COALESCE(b.id, w.id)
)
SELECT
  (SELECT COUNT(*) FROM base)                                       AS 尚可なし件数,
  (SELECT COUNT(*) FROM withnice)                                   AS 尚可あり件数,
  COUNT(*) FILTER (WHERE rk_base IS NULL OR rk_nice IS NULL)        AS 片側にしかいない人,
  COUNT(*) FILTER (WHERE nice_w > 0)                                AS 尚可を満たす人,
  COUNT(*) FILTER (WHERE rk_nice < rk_base)                         AS 順位が上がった人,
  COUNT(*) FILTER (WHERE rk_nice < rk_base AND nice_w = 0)          AS 尚可なしで上がった人,
  CASE
    WHEN COUNT(*) FILTER (WHERE rk_base IS NULL OR rk_nice IS NULL) > 0
      THEN 'FAIL: 尚可で候補者の顔ぶれが変わった'
    WHEN COUNT(*) FILTER (WHERE rk_nice < rk_base AND nice_w = 0) > 0
      THEN 'FAIL: 尚可を満たさない人の順位が上がった'
    WHEN COUNT(*) FILTER (WHERE nice_w > 0) > 0
         AND COUNT(*) FILTER (WHERE rk_nice < rk_base) = 0
      THEN 'FAIL: 尚可を満たす人がいるのに順位が全く動いていない（加点が効いていない）'
    ELSE 'PASS'
  END AS 判定
FROM j;
-- 注: 2つの呼び出しは同一トランザクション内なので裏のワーカー更新では揺れない。
--     同点は created_at DESC で決まるため並びは決定的。
