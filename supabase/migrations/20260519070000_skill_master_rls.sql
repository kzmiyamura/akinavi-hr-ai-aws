-- skill_master テーブルに RLS を有効化
-- SELECT: 全ユーザー（anon含む）可
-- INSERT/UPDATE/DELETE: service_role のみ（Edge Functions）

ALTER TABLE skill_master ENABLE ROW LEVEL SECURITY;

-- 読み取りは全員OK（スキル名は非機密情報）
CREATE POLICY "skill_master_select_all"
  ON skill_master FOR SELECT
  USING (true);

-- 書き込みは service_role のみ（Edge Functions からのみ変更可）
CREATE POLICY "skill_master_insert_service"
  ON skill_master FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "skill_master_update_service"
  ON skill_master FOR UPDATE
  USING (auth.role() = 'service_role');

CREATE POLICY "skill_master_delete_service"
  ON skill_master FOR DELETE
  USING (auth.role() = 'service_role');
