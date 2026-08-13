-- ロール別の statement_timeout を確認する。
-- マッチングRPCがどれだけ余裕を持つべきかの基準になる。
SELECT r.rolname AS ロール, s.setconfig AS 設定
  FROM pg_roles r
  LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid
 WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres')
 ORDER BY r.rolname;
