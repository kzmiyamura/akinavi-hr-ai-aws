-- skill_master テーブル
CREATE TABLE IF NOT EXISTS skill_master (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'languages','frameworks','libraries','os','databases','dwh',
    'clouds','infrastructures','tools','methodologies','certifications',
    'design','marketing','others'
  )),
  aliases jsonb DEFAULT '[]'::jsonb,
  match_count integer DEFAULT 0,
  last_matched_at timestamptz,
  source text DEFAULT 'seed' CHECK (source IN ('seed','ai')),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT skill_master_name_unique UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_skill_master_category ON skill_master(category);
CREATE INDEX IF NOT EXISTS idx_skill_master_source ON skill_master(source);
CREATE INDEX IF NOT EXISTS idx_skill_master_match_count ON skill_master(match_count);
CREATE INDEX IF NOT EXISTS idx_skill_master_last_matched ON skill_master(last_matched_at);

-- match_count を一括インクリメントする RPC
CREATE OR REPLACE FUNCTION increment_skill_match_counts(skill_ids uuid[])
RETURNS void AS $$
  UPDATE skill_master
  SET match_count = match_count + 1,
      last_matched_at = now()
  WHERE id = ANY(skill_ids)
$$ LANGUAGE sql;
