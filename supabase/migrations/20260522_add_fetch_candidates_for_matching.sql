-- マッチング用候補者取得 RPC
-- 優先順位:
--   1. 登録日時が新しい順（最新の候補者が必ず先頭に来る）
--   2. 同秒内は経験年数が多い順（スコア高い候補の代理指標）
-- p_limit: 上限（デフォルト 800）
-- ※一日数千件規模を想定。30日バケツ方式は件数が上限を超えるため不採用。
CREATE OR REPLACE FUNCTION fetch_candidates_for_matching(
  p_data_env text,
  p_limit     int DEFAULT 800
)
RETURNS SETOF candidates
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT *
  FROM candidates
  WHERE data_env   = p_data_env
    AND merged_into IS NULL
  ORDER BY
    created_at DESC,
    COALESCE(experience_years, 0) DESC
  LIMIT p_limit;
$$;
