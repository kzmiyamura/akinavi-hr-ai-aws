-- RLS が有効なテーブルの「ポリシーが実際に何を許しているか」を出す。
-- rls_enabled=true でも、anon に全許可なら実質的に無防備なため中身を確認する。
-- 2026-08-26 作成。
--
-- 実行: npx supabase db query --linked -f scripts/sql/check_rls_policies.sql
--
-- 見方:
--   roles に anon/public が入り cmd=ALL・qual=true → 誰でも全操作可（無効と同じ）

SELECT
  tablename,
  policyname,
  cmd,
  roles::text  AS roles,
  qual         AS using_expr,
  with_check   AS check_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
