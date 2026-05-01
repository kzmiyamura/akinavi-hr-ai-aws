-- Migration: candidate_skillsテーブルの追加（13カテゴリ対応）
-- Supabase SQL Editorで実行してください

CREATE TABLE IF NOT EXISTS candidate_skills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  category     text NOT NULL,
  skill        text NOT NULL,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_skills_candidate_id ON candidate_skills(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_skills_category     ON candidate_skills(category);
CREATE INDEX IF NOT EXISTS idx_candidate_skills_skill        ON candidate_skills(skill);

ALTER TABLE candidate_skills
  ADD CONSTRAINT check_category CHECK (
    category IN (
      'languages', 'frameworks', 'libraries', 'os',
      'databases', 'clouds', 'infrastructures', 'tools',
      'methodologies', 'certifications', 'design', 'marketing', 'others'
    )
  );

-- 既存DBの制約を更新する場合は以下を実行:
-- ALTER TABLE candidate_skills DROP CONSTRAINT check_category;
-- ALTER TABLE candidate_skills ADD CONSTRAINT check_category CHECK (
--   category IN (
--     'languages', 'frameworks', 'libraries', 'os',
--     'databases', 'clouds', 'infrastructures', 'tools',
--     'methodologies', 'certifications', 'design', 'marketing', 'others'
--   )
-- );

ALTER TABLE candidate_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_candidate_skills" ON candidate_skills FOR ALL TO anon USING (true) WITH CHECK (true);
