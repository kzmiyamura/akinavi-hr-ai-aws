-- =============================================================================
-- skill_master 品質改善マイグレーション
-- =============================================================================
-- 目的:
--   1. 欠落していた業界標準スキルを追加（JP1, Teraterm, Zabbix, Hinemos, Tivoli 等）
--   2. 誤マッチを引き起こしていた過度に短いエイリアスを修正（統計→削除 等）
--   3. 添付スキルシートで頻出する資格・ツールを補強
--
-- 安全のため、既存エントリは UPDATE で aliases のみマージ、未登録分のみ INSERT。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- (1) 不適切に短いエイリアスを修正
-- -----------------------------------------------------------------------------

-- 「統計学」: 「統計」だけだと「稼働統計レポート」等にヒットしてしまうので除外。
UPDATE skill_master
SET aliases = '["statistics","統計解析","Statistics","統計学"]'::jsonb
WHERE name = '統計学';

-- 「HTTPS」: URL 直書きを誤拾いしないようエイリアス整理（実マッチは URL ストリップで対応）
UPDATE skill_master
SET aliases = '["TLS","SSL/TLS","ssl/tls"]'::jsonb
WHERE name = 'HTTPS';

-- -----------------------------------------------------------------------------
-- (2) 欠落スキル追加（INSERT ... ON CONFLICT で安全にスキップ）
-- -----------------------------------------------------------------------------

INSERT INTO skill_master (name, category, aliases, source) VALUES

-- ── 運用管理 / 監視 / ジョブスケジューラ（インフラ案件の必須スキル） ──
('JP1', 'tools', '["jp1","JP1/AJS","JP1 AJS","JP1/AJS3","JP1 AJS3","JP1/IM","JP1/IM-View","JP1 IM-View","AJS3","AJS","IM-View","JP1/Base","JP1/Cm2"]'::jsonb, 'seed'),
('Tera Term', 'tools', '["teraterm","TeraTerm","tera term","Tera Term"]'::jsonb, 'seed'),
('Zabbix', 'tools', '["zabbix"]'::jsonb, 'seed'),
('Hinemos', 'tools', '["hinemos"]'::jsonb, 'seed'),
('Tivoli', 'tools', '["tivoli","IBM Tivoli","Tivoli Workload Scheduler","TWS"]'::jsonb, 'seed'),
('Senju', 'tools', '["senju","千手","Senju Family","Senju/SS","Senju/DC"]'::jsonb, 'seed'),
('A-AUTO', 'tools', '["a-auto","A-Auto","aauto"]'::jsonb, 'seed'),
('JobCenter', 'tools', '["jobcenter","Job Center","JobCenter MG/SV"]'::jsonb, 'seed'),
('SystemWalker', 'tools', '["systemwalker","Systemwalker","SystemWalker Operation Manager"]'::jsonb, 'seed'),
('Nagios', 'tools', '["nagios"]'::jsonb, 'seed'),
('Mackerel', 'tools', '["mackerel","mackerel.io"]'::jsonb, 'seed'),

-- ── ファイル転送 / バッチ連携 ──
('HULFT', 'tools', '["hulft","HULFT8","HULFT Square"]'::jsonb, 'seed'),
('FTP', 'tools', '["ftp","SFTP","sftp","FTPS","ftps"]'::jsonb, 'seed'),
('Talend', 'tools', '["talend","Talend Open Studio"]'::jsonb, 'seed'),

-- ── オフィス / コミュニケーション系（添付頻出） ──
('Word', 'tools', '["word","Microsoft Word","ワード","MS Word"]'::jsonb, 'seed'),
('Outlook', 'tools', '["outlook","Microsoft Outlook","MS Outlook"]'::jsonb, 'seed'),
('Lotus Notes', 'tools', '["notes","Lotus Notes","IBM Notes","HCL Notes","Domino"]'::jsonb, 'seed'),
('サクラエディタ', 'tools', '["sakura editor","Sakura Editor","sakuraeditor"]'::jsonb, 'seed'),
('秀丸', 'tools', '["秀丸エディタ","hidemaru","Hidemaru"]'::jsonb, 'seed'),
('WinSCP', 'tools', '["winscp"]'::jsonb, 'seed'),
('Internet Explorer', 'tools', '["ie","IE11","Internet Explorer 11"]'::jsonb, 'seed'),

-- ── レガシー言語・環境 ──
('Visual Basic', 'languages', '["vb","VB","VB6","Visual Basic 6","VB6.0"]'::jsonb, 'seed'),
('VB.NET', 'languages', '["vb.net","vbnet","VB .NET","Visual Basic .NET"]'::jsonb, 'seed'),
('XML', 'languages', '["xml","XSLT","xslt","XSD"]'::jsonb, 'seed'),

-- ── 国内資格（添付スキルシート頻出） ──
('上級情報処理士', 'certifications', '["上級情処士","上級情報処理士資格"]'::jsonb, 'seed'),
('情報処理士', 'certifications', '["情処士"]'::jsonb, 'seed'),
('ITパスポート', 'certifications', '["IP","iパス","iPass","ITパスポート試験","Information Technology Engineers Examination"]'::jsonb, 'seed'),
('P検', 'certifications', '["P検3級","P検2級","P検準2級","P検定","パソコン検定","パソコン検定協会","ICTプロフィシエンシー検定"]'::jsonb, 'seed'),
('コンピュータサービス技能評価試験', 'certifications', '["コンピューターサービス技能評価試験","CS技能評価","表計算3級","表計算2級","ワープロ3級"]'::jsonb, 'seed'),
('ビジネス実務', 'certifications', '["ビジネス実務マナー検定","ビジネス実務法務","ビジネス実務士"]'::jsonb, 'seed'),
('日商簿記3級', 'certifications', '["簿記3級","日商簿記3級"]'::jsonb, 'seed'),
('MOS', 'certifications', '["MOS Excel","MOS Word","Microsoft Office Specialist","MOS スペシャリスト"]'::jsonb, 'seed')

ON CONFLICT (name) DO UPDATE SET
  -- 既存エントリの aliases に新規エイリアスをマージ（重複排除）
  aliases = (
    SELECT to_jsonb(array_agg(DISTINCT v))
    FROM (
      SELECT jsonb_array_elements_text(skill_master.aliases) AS v
      UNION
      SELECT jsonb_array_elements_text(EXCLUDED.aliases) AS v
    ) merged
  );

-- -----------------------------------------------------------------------------
-- (3) 検証用ヘルパー（実行ログに残す）
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  inserted_count int;
BEGIN
  SELECT COUNT(*) INTO inserted_count
  FROM skill_master
  WHERE name IN (
    'JP1','Tera Term','Zabbix','Hinemos','Tivoli','HULFT','FTP',
    'Visual Basic','VB.NET','XML','Word','Outlook','Lotus Notes',
    'サクラエディタ','秀丸','WinSCP','Internet Explorer',
    '上級情報処理士','情報処理士','ITパスポート','P検',
    'コンピュータサービス技能評価試験','ビジネス実務','日商簿記3級','MOS',
    'Senju','A-AUTO','JobCenter','SystemWalker','Nagios','Mackerel','Talend'
  );
  RAISE NOTICE 'fix_skill_master_quality: 対象スキル %/32 件が skill_master に存在', inserted_count;
END $$;
