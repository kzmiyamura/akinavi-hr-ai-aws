-- 尚可スキル加点を足したことで fetch_candidates_for_project がどれだけ遅くなるかを測る。
--
-- クライアント経由（probe_fetch_candidates_timing.mjs）だと 500件×約2KB の転送と
-- ネットワークの揺れが乗って比較にならない（実測 4.9〜10.1秒とばらついた）。
-- ここはサーバ側で件数だけ数えるので転送はゼロ、egress も使わない。
--
-- 注: CLI は superuser で走るので statement_timeout の余裕は分からない（本番は anon 15秒）。
--     ここで見るのは「尚可あり／なしの差」だけ。
-- RAISE NOTICE は db query の結果に出ないので、pg_temp の関数にして値で返す。
CREATE OR REPLACE FUNCTION pg_temp.bench_nice()
RETURNS TABLE(尚可なし_ms numeric, 尚可あり_ms numeric, 差_ms numeric)
LANGUAGE plpgsql AS $$
DECLARE
  t0 timestamptz; n int;
  ms_base numeric; ms_nice numeric;
BEGIN
  -- ウォームアップ（1回目はキャッシュが冷たく差が読めない）
  PERFORM COUNT(*) FROM fetch_candidates_for_project(
    'prod'::text, ARRAY['Java','SQL']::text[], NULL::numeric, NULL::numeric,
    NULL::text, NULL::text, 500, 40, 15, 15, 20, 10,
    false, NULL::text, NULL::text, NULL::integer, NULL::jsonb, NULL::text[]);

  t0 := clock_timestamp();
  SELECT COUNT(*) INTO n FROM fetch_candidates_for_project(
    'prod'::text, ARRAY['Java','SQL']::text[], NULL::numeric, NULL::numeric,
    NULL::text, NULL::text, 500, 40, 15, 15, 20, 10,
    false, NULL::text, NULL::text, NULL::integer, NULL::jsonb, NULL::text[]);
  ms_base := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;

  t0 := clock_timestamp();
  SELECT COUNT(*) INTO n FROM fetch_candidates_for_project(
    'prod'::text, ARRAY['Java','SQL']::text[], NULL::numeric, NULL::numeric,
    NULL::text, NULL::text, 500, 40, 15, 15, 20, 10,
    false, NULL::text, NULL::text, NULL::integer, NULL::jsonb,
    ARRAY['Angular','SQL']::text[]);
  ms_nice := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;

  RETURN QUERY SELECT round(ms_base), round(ms_nice), round(ms_nice - ms_base);
END $$;

SELECT * FROM pg_temp.bench_nice();
