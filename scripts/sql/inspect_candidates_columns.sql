-- candidates の列を確認する（raw_profile を読まずに済む実列があるかの調査用）
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'candidates'
 ORDER BY ordinal_position;
