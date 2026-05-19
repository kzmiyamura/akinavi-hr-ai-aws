-- relevance_keywords テーブル
-- メール関連度判定をAIなしで行うためのキーワードマスタ。
-- type: candidate（人材メール）/ project（案件メール）/ exclude（除外・スパム）

CREATE TABLE IF NOT EXISTS relevance_keywords (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  keyword    text NOT NULL UNIQUE,
  type       text NOT NULL CHECK (type IN ('candidate', 'project', 'exclude')),
  match_count integer NOT NULL DEFAULT 0,
  last_matched_at timestamptz,
  source     text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE relevance_keywords ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON relevance_keywords FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_relevance_keywords_type ON relevance_keywords (type);

-- match_count を一括インクリメントする RPC
CREATE OR REPLACE FUNCTION increment_relevance_match_counts(p_ids bigint[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE relevance_keywords
  SET match_count      = match_count + 1,
      last_matched_at  = now()
  WHERE id = ANY(p_ids);
END;
$$;
