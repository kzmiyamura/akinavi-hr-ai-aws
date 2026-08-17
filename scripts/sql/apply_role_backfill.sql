-- 営業定型文に由来する役割を取り除く（backfill_roles_solicitation.mjs が生成・2026-08-17）
-- 役割を減らすだけ。増やす更新は含まれない。
-- 対象 2 件
BEGIN;
UPDATE candidates SET raw_profile = jsonb_set(raw_profile, '{roles}', '["PMO","プログラマー"]'::jsonb) WHERE id = '39496771-daa0-4c32-92f0-c227fdb2b7d1';
UPDATE candidates SET raw_profile = jsonb_set(raw_profile, '{roles}', '["プロジェクトマネージャー","運用保守","プロジェクトリーダー","テックリード","スクラムマスター"]'::jsonb) WHERE id = '91d09855-7c1d-46f3-b969-6413772646b4';
COMMIT;
