-- Storage のバケット別 件数・合計サイズ
select
  b.name                                                     as bucket,
  b.public                                                   as is_public,
  count(o.id)                                                as files,
  pg_size_pretty(sum((o.metadata->>'size')::bigint))         as total,
  pg_size_pretty(avg((o.metadata->>'size')::bigint)::bigint) as avg_size,
  min(o.created_at)::date                                    as oldest,
  max(o.created_at)::date                                    as newest
from storage.buckets b
left join storage.objects o on o.bucket_id = b.id
group by b.name, b.public
order by sum((o.metadata->>'size')::bigint) desc nulls last;
