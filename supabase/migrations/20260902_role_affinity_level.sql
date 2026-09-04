-- 役割合致度に「到達レベル」と「格上/格下の非対称」を入れる。
-- 定義は docs/ROLE_DEFINITION.md。前段は 20260901_role_taxonomy.sql。
--
-- 背景（2026-09-02）:
--  ① 到達レベルが順位に効いていなかった。
--     ラベルしか見ないので、PMO A級（RFP・ベンダ評価・平均95万）と
--     PMO C級（議事録・PC手配・平均67万）が PM案件に対して同じ -9pt だった。
--     実測（直近7日・prod・PMO 648人）:
--        A級 248人 平均95万 PM併記68.5% 予算/契約/要員への言及 98.4%
--        B級 256人 平均76万 PM併記54.7% 同 92.2%
--        C級  47人 平均67万 PM併記46.8% 同 76.6%
--     PMI の directive PMO は原文で directly manages projects /
--     Project managers report to the PMO。A級PMOがPM業務に届くのは標準どおり。
--
--  ② 格上を格下と同じだけ減点していた（設計の誤り）。
--     実務では「PM経験者をPL案件に出す」は普通で、「PL経験者をPM案件に」は不安。
--     旧は対称だったため、SE案件のアーキテクトが 0.75（格下1段と同じ扱い）だった。
--     非対称にして 0.9 にする。格上でも要求と同じ高さの人が最も合う点は変えない
--     （A級アーキテクトは格上2段になるので 0.8。落としすぎないが最上位でもない）。
--
-- ⚠ 2引数版は残す。3引数版に委譲するだけなので、呼び出し側を直さなくても壊れない。

-- ── 3引数版（人材の到達レベルを受け取る）────────────────────────────────────
-- 実効権限 = ラベルの権限 + レベル補正（A:+2 / B:0 / C:-1 / 不明:0）を 1〜4 に丸めたもの
--   A が +2 なのは、A級が PMOマネジャー・directive PMO 相当で、実測でも
--   98.4% が予算・契約・要員に触れているため。+1 では PM案件で 0.30 にしかならず、
--   C級(0.2)との差が 3pt しか付かない。+2 で 0.45（差 7pt）になる。
-- 権限係数（非対称）:
--   差0        1.0
--   格上1/2/3+ 0.9 / 0.8 / 0.7   ← 格上は落としすぎない
--   格下1/2/3+ 0.75 / 0.5 / 0.3
-- 対象係数は据え置き（距離0→1.0 / 1→0.6 / 2→0.35）。
-- 同一ラベルは 1.0 のまま（案件側に要求レベルが無いので、同一ラベルをレベルで
-- 割り引くと「その案件がA級を求めている」という無い前提を置くことになる。
-- 水準の不一致は単価マッチングが受け持つ＝二重に減点しない）。
CREATE OR REPLACE FUNCTION role_affinity(p_required text, p_candidate text, p_candidate_level text)
RETURNS numeric
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_required IS NULL OR p_candidate IS NULL
      OR btrim(p_required) = '' OR btrim(p_candidate) = ''      THEN 0.5
    WHEN p_required = p_candidate                                THEN 1.0
    ELSE COALESCE((
      SELECT GREATEST(0.2, LEAST(0.9,
               (CASE d.distance WHEN 0 THEN 1.0 WHEN 1 THEN 0.6 ELSE 0.35 END)
             * (CASE
                  WHEN eff.a = r.authority THEN 1.0
                  WHEN eff.a > r.authority THEN
                    CASE eff.a - r.authority WHEN 1 THEN 0.9 WHEN 2 THEN 0.8 ELSE 0.7 END
                  ELSE
                    CASE r.authority - eff.a WHEN 1 THEN 0.75 WHEN 2 THEN 0.5 ELSE 0.3 END
                END)))
      FROM role_axis r
      JOIN role_axis c ON c.label = p_candidate
      JOIN role_object_distance d ON d.a = r.object AND d.b = c.object
      CROSS JOIN LATERAL (
        SELECT LEAST(4, GREATEST(1,
                 c.authority + CASE p_candidate_level
                                 WHEN 'A' THEN 2
                                 WHEN 'C' THEN -1
                                 ELSE 0
                               END)) AS a
      ) eff
      WHERE r.label = p_required
    ), 0.5)
  END;
$$;

GRANT EXECUTE ON FUNCTION role_affinity(text, text, text) TO anon, authenticated;

-- ── 2引数版はレベル不明として委譲する（互換）──────────────────────────────
CREATE OR REPLACE FUNCTION role_affinity(p_required text, p_candidate text)
RETURNS numeric
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT role_affinity(p_required, p_candidate, NULL::text);
$$;

GRANT EXECUTE ON FUNCTION role_affinity(text, text) TO anon, authenticated;

