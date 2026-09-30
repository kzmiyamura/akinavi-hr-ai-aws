-- ============================================================================
-- Free プランの壁に対する現在値を1行の JSON で返す（監視用）
--   scripts/free_plan_watch.mjs から呼ばれる。手で流すなら:
--   npx supabase db query --linked -f scripts/sql/free_plan_watch.sql
--
-- Free の壁: DB 500MB / Storage 1GB / egress 5GB・月 / Edge Function 50万呼び出し・月
-- egress だけは DB からは測れない（課金値はダッシュボードが正）。
-- 本体は1行も返さない。集計値だけなので egress は数KB。
-- ============================================================================
with s as (
  select bucket_id,
         count(*)                                              as n,
         coalesce(sum((metadata->>'size')::bigint), 0)         as b,
         min(created_at)                                       as oldest
    from storage.objects
   group by bucket_id
)
select json_build_object(
  'at',              now(),
  'db_bytes',        pg_database_size(current_database()),
  'storage_bytes',   (select coalesce(sum(b), 0) from s),
  'storage_files',   (select coalesce(sum(n), 0) from s),
  'buckets', (
    select coalesce(json_agg(json_build_object(
             'bucket', bucket_id, 'files', n, 'bytes', b,
             'oldest', oldest::date
           ) order by b desc), '[]'::json) from s
  ),
  -- 直近24時間に増えた分（流入ペース。掃除が効いていればこれが日次の上限増分）
  'storage_in_24h', (
    select coalesce(sum((metadata->>'size')::bigint), 0)
      from storage.objects where created_at > now() - interval '24 hours'
  ),
  'top_tables', (
    select coalesce(json_agg(j order by sz desc), '[]'::json) from (
      select json_build_object('name', c.relname,
                               'bytes', pg_total_relation_size(c.oid)) as j,
             pg_total_relation_size(c.oid) as sz
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'm')
         and n.nspname not in ('pg_catalog', 'information_schema')
       order by sz desc limit 6
    ) x
  ),
  -- 保持が効いているかの裏取り。想定より古い行が残っていたら掃除が止まっている
  'oldest', json_build_object(
    'ai_logs',      (select min(created_at)::date from ai_logs),
    'error_logs',   (select min(occurred_at)::date from error_logs),
    'candidates',   (select min(created_at)::date from candidates),
    'cron_history', (select min(start_time)::date from cron.job_run_details)
  ),
  'rows', json_build_object(
    'ai_logs',                  (select count(*) from ai_logs),
    'candidates',               (select count(*) from candidates),
    'candidate_skills',         (select count(*) from candidate_skills),
    'candidates_archive_light', (select count(*) from candidates_archive_light)
  ),
  -- 消したのに縮んでいない分（VACUUM 待ち）
  'dead_tuples', (
    select coalesce(sum(n_dead_tup), 0) from pg_stat_user_tables
  )
) as j;
