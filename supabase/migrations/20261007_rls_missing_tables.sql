-- 2026-10-07: RLS が有効になっていなかった5表を塞ぐ（Supabase の security advisor `rls_disabled_in_public`）。
--
-- 実測（2026-10-07・pg_class + information_schema.role_table_grants）:
--   notification_log / notification_rules / role_axis / role_master / role_object_distance の5表が
--   relrowsecurity=false・ポリシー0件、かつ anon に SELECT/INSERT/UPDATE/DELETE が付いていた。
--   ＝プロジェクト URL と anon キー（フロントの JS に含まれる＝公開情報）だけで
--   読み取りも削除もできる状態だった。
--
-- ⚠ ポリシーの強さは「今の経路が通る最小」に合わせる。無条件に塞ぐと静かに壊れる:
--   - role_affinity / fetch_candidates_for_project は **SECURITY INVOKER**（prosecdef=false を実測）。
--     role_axis / role_object_distance を anon が読めなくなると、role_affinity が
--     一覧外ラベルと同じ 0.5 を返し、**エラーを出さずにマッチング順位だけが狂う**。
--     だから読み取りは開けたまま、書き込みだけを閉じる。
--   - notification_rules は通知タブが anon キーで CRUD している
--     （src/lib/db/notificationRules.ts）。candidates と同じく anon の全操作を許可する
--     ＝今の挙動を変えない。認証を入れるまではここが上限。
--   - notification_log は notify-candidates（service_role）しか触らない。
--     service_role は RLS を素通りするので、**ポリシーを1つも作らない**＝anon から完全に閉じる。

-- 1) 参照表（役割の分類）: 読み取りだけ残す
ALTER TABLE role_master          ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_axis            ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_object_distance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_master_select_all" ON role_master;
CREATE POLICY "role_master_select_all"
  ON role_master FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "role_axis_select_all" ON role_axis;
CREATE POLICY "role_axis_select_all"
  ON role_axis FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "role_object_distance_select_all" ON role_object_distance;
CREATE POLICY "role_object_distance_select_all"
  ON role_object_distance FOR SELECT TO anon, authenticated USING (true);

-- 2) 通知ルール: 画面が anon キーで CRUD するので今の挙動を維持する
ALTER TABLE notification_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_notification_rules" ON notification_rules;
CREATE POLICY "anon_all_notification_rules"
  ON notification_rules FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 3) 送信済み記録: service_role だけ。ポリシーを作らない（＝anon からは読めも書けもしない）
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
