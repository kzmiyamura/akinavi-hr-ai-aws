-- Migration: 案件の勤務・契約・精算など営業マッチング向けカラム
-- Supabase SQL Editor で実行してください

ALTER TABLE projects ADD COLUMN IF NOT EXISTS work_location text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS remote_policy text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_type text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS headcount integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS workload text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS settlement_min integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS settlement_max integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS role_summary text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS industry text;

COMMENT ON COLUMN projects.work_location IS '勤務地・オフィス・エリア（例: 田町、虎ノ門、大阪梅田）';
COMMENT ON COLUMN projects.remote_policy IS 'リモート可否の要約（例: フルリモート可、週2出社、常駐）';
COMMENT ON COLUMN projects.contract_type IS '契約形態（例: 業務委託、派遣、準委任）';
COMMENT ON COLUMN projects.headcount IS '募集人数（名）。複数窓口なら合算または先頭のみ';
COMMENT ON COLUMN projects.workload IS '稼働イメージ（例: 週5日、月20日、週3）';
COMMENT ON COLUMN projects.settlement_min IS '精算下限（時間）';
COMMENT ON COLUMN projects.settlement_max IS '精算上限（時間）';
COMMENT ON COLUMN projects.role_summary IS '募集役割・ポジション（例: PL、SE、PG、インフラ）';
COMMENT ON COLUMN projects.industry IS '業界・ドメイン（例: 金融、製造、EC）';
