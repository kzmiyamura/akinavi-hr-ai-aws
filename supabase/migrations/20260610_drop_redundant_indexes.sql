-- 冗長・重複インデックスの削除
--
-- ① idx_candidates_skills_gin      → candidates_skills_gin と完全重複（schema.sql が正式版）
-- ② idx_candidates_raw_profile_gin → candidates_raw_profile_gin と完全重複（schema.sql が正式版）
-- ③ idx_candidates_data_env        → idx_candidates_list_env_date (data_env, created_at DESC) でカバー済み

DROP INDEX IF EXISTS idx_candidates_skills_gin;
DROP INDEX IF EXISTS idx_candidates_raw_profile_gin;
DROP INDEX IF EXISTS idx_candidates_data_env;
