-- egress 総点検（2026-09-23）
--
-- 背景: egress の内訳は実測で PostgREST が9割超（＝画面とスクリプトのDB読み取り）。
-- Storage（経歴書DL）はその次。ここでは **本体を1行も返さずに** 体積だけを測る。
--
-- 見るもの:
--   ① 画面が1回で引く量（candidates_lite 等の1行あたりバイト数）— ここが本丸
--   ② raw_profile のどのキーが太いか
--   ③ Storage の使用量と保持（掃除が効いているか）
--   ④ テーブル実サイズ
--
-- ⚠ supabase db query は **最後の結果セットしか返さない**ので、
--    すべて UNION ALL で1つの表にまとめている（2026-09-23 に踏んだ）。
--
-- 実行: npx supabase db query --linked -f scripts/sql/egress_full_check.sql

with lite as (
  select octet_length(t::text) as b from (
    select * from candidates_lite where data_env = 'prod' limit 1000
  ) t
),
raw_c as (
  select octet_length(t::text) as b from (
    select * from candidates where data_env = 'prod' limit 200
  ) t
),
rp as (
  select key, sum(octet_length(value::text)) as total, avg(octet_length(value::text)) as avg
  from candidates c, lateral jsonb_each(c.raw_profile)
  where c.data_env = 'prod' and c.raw_profile is not null
  group by key
),
sto as (
  select bucket_id,
         count(*) as n,
         sum((metadata->>'size')::bigint) as total,
         avg((metadata->>'size')::bigint) as avg,
         min(created_at)::date as oldest
  from storage.objects group by bucket_id
),
tbl as (
  select c.relname as name, pg_total_relation_size(c.oid) as sz, s.n_live_tup as rows
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where n.nspname = 'public' and c.relkind = 'r'
)
select * from (
  -- ① 画面が1回で引く量
  select 1 as ord, '① 1回の転送量' as section, 'candidates_lite 1行' as item,
         pg_size_pretty(avg(b)::bigint) as v1,
         pg_size_pretty((avg(b) * 200)::bigint) as v2, '200行ぶん' as note
  from lite
  union all
  select 1, '① 1回の転送量', 'candidates(生) 1行',
         pg_size_pretty(avg(b)::bigint),
         pg_size_pretty((avg(b) * 200)::bigint), '200行ぶん＝やってはいけない引き方'
  from raw_c
  union all
  -- ② raw_profile の内訳
  select 2, '② raw_profile の太り', key,
         pg_size_pretty(avg::bigint), pg_size_pretty(total), '1件あたり / 全体'
  from (select * from rp order by total desc limit 6) x
  union all
  -- ③ Storage
  select 3, '③ Storage', bucket_id || '（' || n || '件）',
         pg_size_pretty(total), pg_size_pretty(avg::bigint), '最古 ' || oldest
  from sto
  union all
  select 3, '③ Storage', '── 上限1GBに対する使用率',
         round(100.0 * (select sum(total) from sto) / 1073741824, 1)::text || '%',
         pg_size_pretty((select sum(total) from sto)), 'storage_quota_bytes=1GB'
  union all
  -- ④ テーブル
  select 4, '④ テーブル', name, pg_size_pretty(sz), coalesce(rows, 0)::text, '行数'
  from (select * from tbl order by sz desc limit 8) y
) z
order by ord, section, item;
