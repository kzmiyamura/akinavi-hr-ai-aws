-- ai_logs.status に 'skipped' を追加する
--
-- 人材・案件が1件も登録されずに終わったメールは、これまで Edge のログにしか
-- 残らなかった（Edge ログは失効するため後から追えない）。
-- 「添付が付いていたのに登録されなかった」を後から調べられるようにするため、
-- スキップしたメールも ai_logs に1行残す。success と混ぜないよう専用の状態にする。
--
-- ai_logs は 30日で自動削除される（20260609_ailogs_auto_cleanup.sql）ので
-- 行数は増え続けない。

ALTER TABLE ai_logs DROP CONSTRAINT IF EXISTS ai_logs_status_check;
ALTER TABLE ai_logs ADD CONSTRAINT ai_logs_status_check
  CHECK (status IN ('success', 'error', 'skipped'));
