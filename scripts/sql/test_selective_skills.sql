-- 汎用スキル（誰でも持っている必須スキル）の扱いを固定するテスト（2026-08-13）。
--
-- ① selective_skills が汎用スキルだけを落とす
-- ② 必須が汎用スキルだけの案件では元の配列を返す（候補を空にしない）
-- ③ fetch_candidates_for_project が「汎用スキルだけ合致する人」を候補にしない
-- ④ 技術スキルを満たす人は従来どおり候補に残る（絞り込みを効かせすぎていない）
--
-- 前提: refresh_generic_skills() 実行済み（現在の汎用は テスト / 基本設計）。

-- selective_skills の戻り順は保証されない（集合演算の結果）ので、比較は必ず並べ替えてから行う
WITH t AS (
  SELECT
    (SELECT array_agg(x ORDER BY x) FROM unnest(selective_skills(ARRAY['基本設計','PowerShell'])) x) AS 技術混在,
    (SELECT array_agg(x ORDER BY x) FROM unnest(selective_skills(ARRAY['基本設計','テスト'])) x)     AS 汎用のみ,
    (SELECT array_agg(x ORDER BY x) FROM unnest(selective_skills(ARRAY['Java','SQL'])) x)            AS 汎用なし
),
-- ③④ PowerShell 案件の必須スキルで候補集合を比べる
pool AS (
  SELECT
    (SELECT COUNT(*) FROM skill_hit_weights('prod',
       ARRAY['基本設計','Microsoft 365','PowerShell','EntraID','Azure Functions'], NULL)) AS 旧,
    (SELECT COUNT(*) FROM skill_hit_weights('prod',
       selective_skills(ARRAY['基本設計','Microsoft 365','PowerShell','EntraID','Azure Functions']), NULL)) AS 現,
    (SELECT COUNT(*) FROM fetch_candidates_for_project(
       'prod'::text,
       ARRAY['基本設計','Microsoft 365','PowerShell','EntraID','Azure Functions']::text[],
       NULL::numeric, NULL::numeric, NULL::text, NULL::text, 3000,
       40, 15, 15, 20, 10, false, NULL::text, NULL::text, NULL::integer,
       NULL::jsonb, NULL::text[]))                                                        AS rpc件数
)
SELECT
  array_to_string(t.技術混在, ',')  AS 技術混在_結果,
  array_to_string(t.汎用のみ, ',')  AS 汎用のみ_結果,
  array_to_string(t.汎用なし, ',')  AS 汎用なし_結果,
  pool.旧                            AS 旧_候補人数,
  pool.現                            AS 現_候補人数,
  pool.rpc件数                       AS RPCが返した人数,
  CASE
    WHEN t.技術混在 <> ARRAY['PowerShell']
      THEN 'FAIL: 汎用スキルが落ちていない'
    WHEN t.汎用のみ <> ARRAY['テスト','基本設計']
      THEN 'FAIL: 全部汎用のとき元の配列を返していない（候補が空になる）'
    WHEN t.汎用なし <> ARRAY['Java','SQL']   -- 並べ替え済みなので Java,SQL の順
      THEN 'FAIL: 技術スキルまで落としている'
    WHEN pool.現 >= pool.旧
      THEN 'FAIL: 絞り込みが効いていない'
    WHEN pool.rpc件数 <> pool.現
      THEN 'FAIL: RPC の候補集合が selective_skills と一致しない'
    WHEN pool.現 = 0
      THEN 'FAIL: 候補が空になった（絞り込みすぎ）'
    ELSE 'PASS'
  END AS 判定
FROM t, pool;
