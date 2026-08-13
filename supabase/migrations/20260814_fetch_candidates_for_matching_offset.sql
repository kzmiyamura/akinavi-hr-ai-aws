-- fetch_candidates_for_matching に p_offset を足す（1000行の頭打ち対策）
--
-- 問題（2026-08-14 実測）:
--   この RPC は p_limit=2000 で呼ばれているのに、常に 1000 件しか返っていなかった。
--   PostgREST の db-max-rows（1000）で**黙って**切られているため。
--   Range ヘッダを付けても RPC には効かない（0-999 / 1000-1999 / 2000-2999 のいずれも
--   同じ先頭1000件が返ることを実測）。
--
--   prod の人材は 1,521 人。つまり3分の1が一覧から欠けており、
--   - 人材モードの検索・「全人材を再マッチング」の対象から漏れる
--   - 案件モードのランキングでは、一覧に居ない人が画面から消えていた
--     （上位20位中 5〜9人が非表示。全 open 8案件で発生）
--
-- 対策: SQL 側で OFFSET を受けられるようにして、呼び出し側が1000件ずつ回して集める。
--   引数リストが変わるので CREATE OR REPLACE では上書きできない（別オーバーロードになり
--   PostgREST が曖昧になる）。必ず DROP してから作り直す。
--
-- 並び順・絞り込み条件は 20260609_reduce_egress_strip_rawprofile.sql から変更なし。
-- ORDER BY が決定的でないとページ間で取りこぼす/重複するため、
-- 同着を割るための id を最後に足してある。

DROP FUNCTION IF EXISTS fetch_candidates_for_matching(text, int);
DROP FUNCTION IF EXISTS fetch_candidates_for_matching(text, int, int);

CREATE FUNCTION fetch_candidates_for_matching(
  p_data_env text,
  p_limit    int DEFAULT 1000,
  p_offset   int DEFAULT 0
)
RETURNS SETOF candidates_lite
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT *
  FROM candidates_lite
  WHERE data_env      = p_data_env
    AND merged_into   IS NULL
    AND duplicate_flag = false
  ORDER BY
    created_at DESC,
    COALESCE(experience_years, 0) DESC,
    id
  LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION fetch_candidates_for_matching(text, int, int) TO anon, authenticated;
