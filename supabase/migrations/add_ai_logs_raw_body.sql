-- ai_logs テーブルにメール本文（raw_body）カラムを追加
-- 品質チェック用: AIの解析結果と元メール本文を突合できるようにする
ALTER TABLE ai_logs
  ADD COLUMN IF NOT EXISTS raw_body TEXT;

COMMENT ON COLUMN ai_logs.raw_body IS 'メール本文（HTML除去後プレーンテキスト）の先頭3000文字。品質チェック用。';
