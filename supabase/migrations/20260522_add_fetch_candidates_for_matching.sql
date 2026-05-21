-- マッチング用候補者取得 RPC
-- 優先順位:
--   1. 直近30日以内に登録された人（全員・漏れなし）
--   2. それより古い人は経験年数が多い順（スコア高い候補の代理指標）
--   3. 同順位内は登録日が新しい順
-- p_limit: 上限（デフォルト 800）
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
    -- 直近30日を先頭に
    (CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) DESC,
    -- 次に経験年数降順（NULL は末尾）
    COALESCE(experience_years, 0) DESC,
    -- 同点は新しい登録順
    created_at DESC
  LIMIT p_limit;
$$;
