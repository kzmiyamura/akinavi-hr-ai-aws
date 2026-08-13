-- attachments バケットのフォルダ別 件数・サイズ・最古日
-- cleanup-storage は attachments/resumes だけを 7日で消す。対象外のフォルダが
-- 溜まり続けていないかを見る
select
  split_part(name, '/', 1)                           as folder,
  count(*)                                           as files,
  pg_size_pretty(sum((metadata->>'size')::bigint))   as total,
  min(created_at)::date                              as oldest,
  max(created_at)::date                              as newest
from storage.objects
where bucket_id = 'attachments'
group by 1
order by sum((metadata->>'size')::bigint) desc;
