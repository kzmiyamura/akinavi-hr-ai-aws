-- フロントエンドのエラーを保存するテーブル
-- 「帰宅後に今日のエラーを確認して直す」用途
CREATE TABLE IF NOT EXISTS error_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  page         text,          -- エラーが発生したページ/コンポーネント名
  message      text NOT NULL, -- エラーメッセージ
  stack        text,          -- スタックトレース
  context      jsonb,         -- 追加コンテキスト（操作内容・引数など）
  data_env     text,
  nickname     text
);

-- 古いログを自動削除（30日以上前）
CREATE INDEX IF NOT EXISTS error_logs_occurred_at_idx ON error_logs (occurred_at DESC);

-- RLS: anon/authenticated どちらも INSERT/SELECT 可
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_error_logs" ON error_logs FOR ALL USING (true) WITH CHECK (true);
