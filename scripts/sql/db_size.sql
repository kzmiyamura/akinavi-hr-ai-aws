-- DB全体の使用量。無料枠の上限（500MB）に対する余裕を見る（読み取りのみ）
select
  pg_size_pretty(pg_database_size(current_database())) as database_total,
  pg_database_size(current_database()) as bytes;
