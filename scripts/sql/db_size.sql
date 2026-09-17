-- ============================================================================
-- DB がどれだけ枠を使っているか（無料版の上限 500MB に対して）
-- ============================================================================
--   npx supabase db query --linked -f scripts/sql/db_size.sql
--
-- 掃除の前後で必ず流して、「やった」ではなく「何MB返った」を残すために使う。
-- 集計のみ・本体は返さないので egress は数KB。
-- ============================================================================
with dbsz as (select pg_database_size(current_database()) as b)
select '01 DB 全体' as 項目,
       pg_size_pretty(b) || '  （上限500MB の ' || round(100.0*b/(500*1024*1024)) || '%）' as 値
  from dbsz
union all
select '02 Storage 実体',
       pg_size_pretty(sum(coalesce((metadata->>'size')::bigint,0))::bigint)
       || '  （上限1GB の ' || round(100.0*sum(coalesce((metadata->>'size')::bigint,0))/(1024^3)) || '%）'
  from storage.objects
union all
select '03 上位8テーブル（本体+索引+TOAST）',
       string_agg(t, ' / ' order by sz desc)
  from (
    select format('%s %s', c.relname, pg_size_pretty(pg_total_relation_size(c.oid))) as t,
           pg_total_relation_size(c.oid) as sz
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where c.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema')
     order by sz desc limit 8
  ) x
union all
select '04 candidates の内訳（本体 / 索引 / TOAST）',
       pg_size_pretty(pg_relation_size('public.candidates')) || ' / '
       || pg_size_pretty(pg_indexes_size('public.candidates')) || ' / '
       || pg_size_pretty(coalesce((select pg_total_relation_size(reltoastrelid)
                                     from pg_class where oid='public.candidates'::regclass), 0))
union all
select '05 ai_logs の内訳（本体 / 索引 / TOAST）',
       pg_size_pretty(pg_relation_size('public.ai_logs')) || ' / '
       || pg_size_pretty(pg_indexes_size('public.ai_logs')) || ' / '
       || pg_size_pretty(coalesce((select pg_total_relation_size(reltoastrelid)
                                     from pg_class where oid='public.ai_logs'::regclass), 0))
union all
-- 保持期間が効いているか。想定より古い行が残っていたら掃除が動いていない
select '06 保持の実績（最古の行）',
       'ai_logs ' || coalesce((select min(created_at)::date::text from ai_logs), '-')
       || ' / cron履歴 ' || coalesce((select min(start_time)::date::text from cron.job_run_details), '-')
       || ' / 添付 ' || coalesce((select min(created_at)::date::text from storage.objects
                                   where bucket_id='attachments'), '-')
union all
-- 消したのに縮んでいない分の目安
select '07 死んだ行が多い表（上位5）',
       coalesce(string_agg(t, ' / ' order by d desc), 'なし')
  from (
    select format('%s %s行', relname, n_dead_tup) as t, n_dead_tup as d
      from pg_stat_user_tables where n_dead_tup > 1000
     order by n_dead_tup desc limit 5
  ) y
union all
-- 使われていない索引（stats_reset を見てから判断すること）
select '08 一度も使われていない索引（合計）',
       coalesce(pg_size_pretty(sum(pg_relation_size(indexrelid))::bigint), '0')
       || ' / ' || count(*)::text || '本'
  from pg_stat_user_indexes where idx_scan = 0
union all
select '09 統計のリセット日時（08の根拠）',
       coalesce((select stats_reset::date::text from pg_stat_database
                  where datname=current_database()), 'リセットされていない')
       || '  DB稼働 ' || round(extract(epoch from (now()-pg_postmaster_start_time()))/86400, 1) || '日';
