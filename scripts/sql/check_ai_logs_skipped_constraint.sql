-- ai_logs.status の CHECK に 'skipped' が入ったかの確認
SELECT pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'ai_logs'::regclass AND conname = 'ai_logs_status_check';
