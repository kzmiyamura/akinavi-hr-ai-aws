-- マッチング1クリックの転送量の内訳を出す（2026-09-23）
--
-- 実測: fetch_candidates_for_project は1案件で 2,312kB（500人）を返す。
-- egress の最大消費源。まず**どの列が重いのか**を測ってから削る。
-- （HANDOFF.md の「ランキングの遅延取得 1.63MB → 約230KB」は着手されないまま増えていた）
--
-- 本体は返さない。列ごとのバイト数だけ。

with rows500 as (
  select * from candidates_lite where data_env = 'prod' limit 500
),
per_col as (
  select 'raw_profile'  as col, sum(octet_length(raw_profile::text))     as bytes from rows500
  union all select 'skills',     sum(octet_length(skills::text))          from rows500
  union all select 'name',       sum(octet_length(coalesce(name, '')))    from rows500
  union all select 'desired_rate', sum(octet_length(coalesce(desired_rate, ''))) from rows500
  union all select 'from_company', sum(octet_length(coalesce(from_company, ''))) from rows500
  union all select 'resume_url',  sum(octet_length(coalesce(resume_url, ''))) from rows500
  union all select 'email+phone', sum(octet_length(coalesce(email, '') || coalesce(phone, ''))) from rows500
),
rp_keys as (
  select key, sum(octet_length(value::text)) as bytes
  from rows500 r, lateral jsonb_each(r.raw_profile)
  group by key
),
total as (select sum(octet_length(t::text)) as bytes from rows500 t)
select * from (
  select 1 as ord, '■ 合計' as section, '500人ぶん' as item,
         pg_size_pretty((select bytes from total)) as size, '' as pct
  union all
  select 2, '■ 列ごと', col, pg_size_pretty(bytes),
         round(100.0 * bytes / (select bytes from total))::text || '%'
  from per_col
  union all
  select 3, '■ raw_profile の中身', key, pg_size_pretty(bytes),
         round(100.0 * bytes / (select bytes from total))::text || '%'
  from (select * from rp_keys order by bytes desc limit 12) k
) z
order by ord, size desc;
