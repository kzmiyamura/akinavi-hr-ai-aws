-- 論理環境（同一Supabase内で prod / demo を分離）
-- アプリ側は通常プロダクトデータのみ prod を参照し、営業デモ・ダミー投入は demo に閉じる。

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS data_env text NOT NULL DEFAULT 'demo';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS data_env text NOT NULL DEFAULT 'demo';

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS data_env text NOT NULL DEFAULT 'demo';

-- 既存行はテスト中データとして demo に統一（後から prod を増やす）
UPDATE candidates SET data_env = 'demo' WHERE data_env IS DISTINCT FROM 'demo';
UPDATE projects SET data_env = 'demo' WHERE data_env IS DISTINCT FROM 'demo';
UPDATE submissions SET data_env = 'demo' WHERE data_env IS DISTINCT FROM 'demo';

ALTER TABLE candidates
  DROP CONSTRAINT IF EXISTS candidates_data_env_check;
ALTER TABLE candidates
  ADD CONSTRAINT candidates_data_env_check CHECK (data_env IN ('prod','demo'));

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_data_env_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_data_env_check CHECK (data_env IN ('prod','demo'));

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_data_env_check;
ALTER TABLE submissions
  ADD CONSTRAINT submissions_data_env_check CHECK (data_env IN ('prod','demo'));

CREATE INDEX IF NOT EXISTS idx_candidates_data_env ON candidates (data_env);
CREATE INDEX IF NOT EXISTS idx_projects_data_env ON projects (data_env);
CREATE INDEX IF NOT EXISTS idx_submissions_data_env ON submissions (data_env);
