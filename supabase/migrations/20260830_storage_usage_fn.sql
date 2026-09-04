-- ストレージ使用量を取得する関数（2026-08-30 追加）
--
-- 経緯: raw/（受信添付の控え）が掃除の不具合で1.7GBまで膨らみ、無料枠1GBを超過。
-- 2026-08-30 にプロジェクト全体が 402 で停止した（Fair Use Policy）。
-- 枠に対する残量を誰も見ていなかったことが再発の温床なので、監視から呼べるようにする。
--
-- storage.objects は PostgREST から読めないため、public に読み取り専用の関数を置く。
-- security definer だが、返すのは合計バイト数と件数だけで、ファイルの中身や名前は返さない。

create or replace function public.storage_usage()
returns table (bucket text, files bigint, bytes bigint)
language sql
security definer
set search_path = storage, public
as $$
  select bucket_id::text as bucket,
         count(*)::bigint as files,
         coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
  from storage.objects
  group by bucket_id
$$;

comment on function public.storage_usage() is
  'バケット別のファイル数と合計バイト数。容量監視（notify-candidates）から呼ぶ。';

revoke all on function public.storage_usage() from public, anon;
grant execute on function public.storage_usage() to service_role;
