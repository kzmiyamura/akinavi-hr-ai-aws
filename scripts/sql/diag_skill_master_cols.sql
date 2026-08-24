-- skill_master の列構成（2026-08-19）。同梱データの版管理に使える列があるか確認する。
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='skill_master' ORDER BY ordinal_position;
