-- ai_logs の列構成を確認する（行は返さない・2026-08-17）
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ai_logs'
ORDER BY ordinal_position;
