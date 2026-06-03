-- Issue #65: candidates_archive_light の RLS を有効化してセキュリティ警告を解消

ALTER TABLE candidates_archive_light ENABLE ROW LEVEL SECURITY;

-- anon / authenticated に読み取りを許可（archive-candidates Edge Function は service_role で読み書き）
DROP POLICY IF EXISTS "allow_read_archive" ON candidates_archive_light;
CREATE POLICY "allow_read_archive"
  ON candidates_archive_light
  FOR SELECT
  TO anon, authenticated
  USING (true);
