-- public スキーマのテーブルごとに RLS の有効/無効とポリシー数を出す。
-- Supabase のセキュリティ警告 rls_disabled_in_public の対象を特定するため。
-- 2026-08-26 作成。
--
-- 実行: npx supabase db query --linked -f scripts/sql/check_rls_status.sql
--
-- 見方:
--   rls_enabled = false          → 誰でも読み書き削除できる（警告の対象）
--   rls_enabled = true, policies = 0 → 誰もアクセスできない（service_role は除く）

SELECT
  c.relname                        AS table_name,
  c.relrowsecurity                 AS rls_enabled,
  c.relforcerowsecurity            AS rls_forced,
  count(p.polname)                 AS policies,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity, c.oid
ORDER BY c.relrowsecurity ASC, c.relname;
