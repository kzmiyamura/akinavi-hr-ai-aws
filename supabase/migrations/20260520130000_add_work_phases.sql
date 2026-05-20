-- =============================================================================
-- 工程・フェーズ系エントリを skill_master に追加
-- =============================================================================
-- 目的:
--   【工程】欄に記載される「構築」「テスト」「運用保守」「障害対応」「システム移行」等が
--   スキルとして抽出されないため、methodologies カテゴリに追加する。
--   また DB2, AIX など IBM ミドルウェア系も補強。
-- =============================================================================

INSERT INTO skill_master (name, category, aliases, source) VALUES

-- ── 開発工程・フェーズ ──
('構築', 'methodologies', '["インフラ構築","システム構築","環境構築","サーバー構築","NW構築","ネットワーク構築","基盤構築","クラウド構築","DB構築"]'::jsonb, 'seed'),
('テスト', 'methodologies', '["単体テスト","結合テスト","システムテスト","総合テスト","UAT","受入テスト","ST","IT","UT","テスト実施","テスト工程"]'::jsonb, 'seed'),
('運用', 'methodologies', '["システム運用","インフラ運用","サーバー運用","クラウド運用","IT運用","保守運用","24時間運用","365日運用"]'::jsonb, 'seed'),
('運用保守', 'methodologies', '["保守・運用","運用・保守","運用/保守","保守/運用","システム保守","インフラ保守","アプリ保守","Web保守"]'::jsonb, 'seed'),
('障害対応', 'methodologies', '["インシデント対応","障害切り分け","障害解析","障害復旧","トラブルシューティング","障害調査","一次対応","二次対応"]'::jsonb, 'seed'),
('システム移行', 'methodologies', '["データ移行","DB移行","環境移行","クラウド移行","マイグレーション","migration","リプレイス","更改","システム刷新","基盤移行","OS移行"]'::jsonb, 'seed'),
('監視', 'methodologies', '["システム監視","インフラ監視","死活監視","リソース監視","ログ監視","アラート監視","監視設計","監視運用"]'::jsonb, 'seed'),
('バックアップ', 'methodologies', '["バックアップ設計","バックアップ運用","データバックアップ","リストア","バックアップリストア"]'::jsonb, 'seed'),
('リリース管理', 'methodologies', '["リリース作業","本番リリース","リリース手順","デプロイ作業","本番適用","本番反映"]'::jsonb, 'seed'),
('PMO', 'methodologies', '["pmo","プロジェクト管理オフィス","Project Management Office","PMOサポート"]'::jsonb, 'seed'),

-- ── IBM ミドルウェア / AIX・DB2 系（エンプラ案件頻出） ──
('AIX', 'os', '["aix","IBM AIX","AIX 7.1","AIX 7.2","AIX 7.3"]'::jsonb, 'seed'),
('DB2', 'databases', '["db2","IBM DB2","DB2 for LUW","DB2 for z/OS","DB2 for i"]'::jsonb, 'seed'),
('WebSphere', 'frameworks', '["websphere","IBM WebSphere","WAS","WebSphere Application Server","IBM WAS"]'::jsonb, 'seed'),
('Tivoli Storage Manager', 'tools', '["tsm","TSM","IBM TSM","Spectrum Protect","IBM Spectrum Protect"]'::jsonb, 'seed'),
('HACMP', 'tools', '["hacmp","IBM HACMP","PowerHA","IBM PowerHA"]'::jsonb, 'seed'),
('GPFS', 'tools', '["gpfs","IBM GPFS","Spectrum Scale","IBM Spectrum Scale"]'::jsonb, 'seed'),

-- ── ストレージ / NetApp ──
('NetApp', 'tools', '["netapp","NetApp ONTAP","ONTAP","NetApp SnapMirror"]'::jsonb, 'seed'),
('EMC', 'tools', '["emc","EMC Unity","EMC VNX","EMC VMAX","Dell EMC","PowerStore"]'::jsonb, 'seed'),
('Hitachi', 'tools', '["hitachi","Hitachi VSP","HUS","Hitachi NAS","Hitachi Ops Center"]'::jsonb, 'seed'),
('StorageWorks', 'tools', '["storageworks","HP StorageWorks","HPE StorageWorks"]'::jsonb, 'seed')

ON CONFLICT (name) DO UPDATE SET
  aliases = (
    SELECT to_jsonb(array_agg(DISTINCT v))
    FROM (
      SELECT jsonb_array_elements_text(skill_master.aliases) AS v
      UNION
      SELECT jsonb_array_elements_text(EXCLUDED.aliases) AS v
    ) merged
  );

-- 検証
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM skill_master
  WHERE name IN ('構築','テスト','運用','運用保守','障害対応','システム移行','監視','DB2','AIX','WebSphere');
  RAISE NOTICE 'add_work_phases: 対象 10件中 % 件が skill_master に存在', cnt;
END $$;
