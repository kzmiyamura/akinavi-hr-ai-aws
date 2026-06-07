-- 人材一覧クエリ（data_env=prod AND merged_into IS NULL ORDER BY created_at DESC）用の部分インデックス
-- candidates_lite ビューも同じ base table を参照するため有効
CREATE INDEX IF NOT EXISTS idx_candidates_list_env_date
  ON candidates (data_env, created_at DESC)
  WHERE merged_into IS NULL;
