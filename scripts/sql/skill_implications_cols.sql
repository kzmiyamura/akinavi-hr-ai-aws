SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS 列
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'skill_implications';
