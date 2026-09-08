-- 保持期間を過ぎた Storage オブジェクトの一覧を返す関数（2026-09-09 追加）
--
-- 経緯: cleanup-storage の raw/ 掃除は、フォルダを名前順に list して1つずつ中を見る作りで、
-- 110秒の予算を使い切ると中断していた。**再開位置を持っていない**ので毎回 offset 0 から
-- 走り直し、予算内に到達できない後半は永久に消えなかった。
-- 2026-08-30 には同じ経路で raw/ が1.7GBまで膨らみ、無料枠を超えてプロジェクトが402で停止。
-- 2026-08-28 に「1,000件で打ち切り」を直したが、上限が時間予算に変わっただけで病気は残っていた。
-- 実測（2026-09-09）: raw_retention_days=1 なのに 8/30〜9/06 の 1,880件・319MB が残存。
--
-- 5,330フォルダを1件ずつ list して回るのをやめ、DB に古いファイルを直接聞く。
-- storage.objects は PostgREST から読めないため、public に読み取り専用の関数を置く
-- （storage_usage() と同じ方式）。返すのはパスとサイズだけ。

create or replace function public.list_old_storage_objects(
  p_bucket text,
  p_prefix text,
  p_cutoff timestamptz,
  p_limit  int default 500
)
returns table (path text, bytes bigint)
language sql
security definer
set search_path = storage, public
as $$
  select o.name::text as path,
         coalesce((o.metadata->>'size')::bigint, 0)::bigint as bytes
  from storage.objects o
  where o.bucket_id = p_bucket
    and o.name like p_prefix || '%'
    and o.created_at < p_cutoff
  order by o.created_at asc
  limit least(greatest(coalesce(p_limit, 500), 1), 2000)
$$;

comment on function public.list_old_storage_objects(text, text, timestamptz, int) is
  '保持期間を過ぎた Storage オブジェクトのパス。cleanup-storage が削除対象を引くのに使う。'
  ' フォルダを列挙して回る方式は再開位置を持てず、後半に永久に到達しなかった（2026-09-09）。';

revoke all on function public.list_old_storage_objects(text, text, timestamptz, int) from public, anon;
grant execute on function public.list_old_storage_objects(text, text, timestamptz, int) to service_role;
