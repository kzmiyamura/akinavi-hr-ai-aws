-- llm_shadow の列構成（2026-08-19）。AI の返答のどこに mailType が残っているか確認する。
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='llm_shadow' ORDER BY ordinal_position;
