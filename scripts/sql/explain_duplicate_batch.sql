-- find_duplicate_candidates_batch の実行計画。
-- 正規化名のインデックス（idx_candidates_name_normalized）が使われているかを見る。
-- 使われていないと候補者が増えるほど全表走査 × 対象人数で悪化する。
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
WITH ids AS (
  SELECT array_agg(candidate_id) AS arr
  FROM (
    SELECT candidate_id
    FROM submissions
    WHERE data_env = 'prod'
    ORDER BY match_score DESC
    LIMIT 100
  ) t
)
SELECT count(*) FROM ids, LATERAL find_duplicate_candidates_batch(ids.arr, 'prod');
