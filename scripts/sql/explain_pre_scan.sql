-- candidates_lite（raw_profile - 'text' - 'parsedGrid' を行ごとに評価するビュー）の
-- 実体化コストを測る。count(*) だと列が読まれず 0ms になるので、
-- raw_profile を実際に組み立てさせて測る。

EXPLAIN (ANALYZE, BUFFERS)
SELECT sum(length(c.raw_profile::text)) FROM (
  SELECT * FROM candidates_lite
   WHERE data_env = 'prod' AND merged_into IS NULL AND duplicate_flag = false
   LIMIT 500
) c;
