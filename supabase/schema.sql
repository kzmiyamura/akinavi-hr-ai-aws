-- ============================================================
-- AkiNavi HR-AI: DB スキーマ定義
-- Phase 1 — Supabase (PostgreSQL) で実行してください
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. candidates（人材マスタ）
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 基本情報
  name             text        NOT NULL,
  email            text        UNIQUE,          -- NULL 可（メール無し人材も登録可能）
  phone            text,

  -- AI 解析結果を柔軟に格納
  skills           jsonb       NOT NULL DEFAULT '[]',   -- 例: ["Java","AWS","PM"]
  experience_years integer,
  raw_profile      jsonb       NOT NULL DEFAULT '{}',   -- メール本文・その他生データ

  -- 重複管理
  duplicate_flag   boolean     NOT NULL DEFAULT false,  -- AI が「似ている」と判断
  merged_into      uuid        REFERENCES candidates(id) ON DELETE SET NULL,
                                                        -- マージ先 ID（論理削除）

  -- 運用メタ
  created_by       text        NOT NULL,                -- localStorage ニックネーム
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- email 重複チェック用インデックス（NULL は除外）
CREATE UNIQUE INDEX IF NOT EXISTS candidates_email_unique
  ON candidates (email)
  WHERE email IS NOT NULL;

-- JSONB 全文検索用 GIN インデックス
CREATE INDEX IF NOT EXISTS candidates_skills_gin
  ON candidates USING GIN (skills);

CREATE INDEX IF NOT EXISTS candidates_raw_profile_gin
  ON candidates USING GIN (raw_profile);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER candidates_updated_at
  BEFORE UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ────────────────────────────────────────────────────────────
-- 2. projects（案件マスタ）
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title            text        NOT NULL,
  client           text,
  description      text,

  -- AI 解析結果
  required_skills  jsonb       NOT NULL DEFAULT '[]',   -- 例: ["React","Node.js"]
  budget_min       integer,
  budget_max       integer,
  start_date       date,
  end_date         date,
  raw_data         jsonb       NOT NULL DEFAULT '{}',

  status           text        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','filled','closed')),

  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_required_skills_gin
  ON projects USING GIN (required_skills);

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ────────────────────────────────────────────────────────────
-- 3. submissions（マッチング提案履歴）
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  candidate_id     uuid        NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  project_id       uuid        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,

  -- AI スコアリング結果
  match_score      numeric(5,2),                        -- 0.00 〜 100.00
  ai_summary       text,                                -- AI によるマッチング理由
  ai_raw           jsonb       NOT NULL DEFAULT '{}',   -- OpenAI レスポンス生データ

  status           text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','accepted','rejected')),

  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (candidate_id, project_id)                    -- 同一ペアの重複提案を防止
);

CREATE TRIGGER submissions_updated_at
  BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ────────────────────────────────────────────────────────────
-- 4. app_config（アプリ全体設定）
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_config (
  key              text PRIMARY KEY,
  value            jsonb       NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- デフォルト設定を投入
INSERT INTO app_config (key, value) VALUES
  ('matching', '{"min_score": 60, "top_n": 5, "similarity_threshold": 0.8}'),
  ('ai',       '{"model": "gpt-4o-mini", "max_tokens": 1000}')
ON CONFLICT (key) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 5. RLS ポリシー（ログインなし・ニックネーム制のため anon に全操作を許可）
-- ────────────────────────────────────────────────────────────

ALTER TABLE candidates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_candidates"  ON candidates  FOR ALL    TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_projects"    ON projects    FOR ALL    TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_submissions" ON submissions FOR ALL    TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_read_app_config" ON app_config  FOR SELECT TO anon USING (true);

-- ============================================================
-- 完了
-- ============================================================
