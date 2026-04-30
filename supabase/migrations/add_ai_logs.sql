-- Migration: AI解析ログテーブルの追加
-- 既存の Supabase DB に対してこの SQL を実行してください

CREATE TABLE IF NOT EXISTS ai_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text        NOT NULL,
  model            text        NOT NULL,
  from_address     text,
  subject          text,
  ai_result        jsonb       NOT NULL DEFAULT '{}',
  prompt_length    integer,
  status           text        NOT NULL DEFAULT 'success'
                   CHECK (status IN ('success','error')),
  error_message    text,
  duration_ms      integer,
  linked_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_logs_type_idx       ON ai_logs (type);
CREATE INDEX IF NOT EXISTS ai_logs_created_at_idx ON ai_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_logs_linked_id_idx  ON ai_logs (linked_id);

ALTER TABLE ai_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_ai_logs" ON ai_logs FOR ALL TO anon USING (true) WITH CHECK (true);
