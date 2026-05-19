-- 検索高速化: raw_profile に GIN インデックスを追加
-- raw_profile::text ILIKE のフルスキャンを解消する

-- candidates の raw_profile GINインデックス
CREATE INDEX IF NOT EXISTS idx_candidates_raw_profile_gin
  ON candidates USING gin (raw_profile);

-- skills の GINインデックス（jsonb配列の検索高速化）
CREATE INDEX IF NOT EXISTS idx_candidates_skills_gin
  ON candidates USING gin (skills);

-- name の trigram インデックス（部分一致高速化）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_candidates_name_trgm
  ON candidates USING gin (name gin_trgm_ops);
