-- Storage の中身を調べる。バケット別の件数・合計サイズと、大きいファイル上位。
select
  b.name                                                as bucket,
  count(o.id)                                           as files,
  pg_size_pretty(sum((o.metadata->>'size')::bigint))    as total,
  pg_size_pretty(avg((o.metadata->>'size')::bigint)::bigint) as avg_size,
  min(o.created_at)::date                               as oldest,
  max(o.created_at)::date                               as newest
from storage.buckets b
left join storage.objects o on o.bucket_id = b.id
group by b.name
order by sum((o.metadata->>'size')::bigint) desc nulls last;

-- 大きいファイル上位10件
select
  bucket_id,
  name,
  pg_size_pretty((metadata->>'size')::bigint) as size,
  created_at::date
from storage.objects
order by (metadata->>'size')::bigint desc nulls last
limit 10;

-- 月別の追加量（増え方の傾向）
select
  to_char(created_at, 'YYYY-MM')                     as month,
  count(*)                                           as files,
  pg_size_pretty(sum((metadata->>'size')::bigint))   as added
from storage.objects
group by 1
order by 1 desc
limit 6;
