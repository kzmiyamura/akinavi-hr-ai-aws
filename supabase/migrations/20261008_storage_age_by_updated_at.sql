-- 経歴書の保持を「最初に上がった日」ではなく「最後に上がった日」で測る（2026-10-08）
--
-- ■ 何が起きていたか
--   `resumes/` のファイル名は内容ハッシュ（`stableResumeName`: 氏名_sha256(内容)[:20].拡張子）。
--   同じ経歴書が再送されると**同じパスへの upsert** になるので、
--   `storage.objects.updated_at` は進むが **`created_at` は初回のまま動かない**。
--   `list_old_storage_objects` は `created_at < cutoff` で切っていたため、
--   初回から7日経った時点で、**その日に上がり直したばかりのファイルでも消していた**。
--   `cleanup-storage` は消すと同時に `candidates.resume_url` を null にするので、
--   画面から経歴書リンクが消える。
--
--   **毎日売り込まれている人材ほど先に消える**＝営業が一番見たい人から壊れる。
--
-- ■ 実測（2026-10-08・prod）
--   ・取り込みログ（pipeline_trace）に E-URL-STORAGE があり経歴書が正常に上がった prod 人材 2,194人
--     そのうち **resume_url が null になっている 427人（19%）**。直近2日の登録に限っても 66人
--   ・`resumes/` の 2,329件中 **636件は updated_at が created_at より1日以上新しい**＝再送で上がり直している
--   ・実例: リクラシの TI さん。10/07 00:00 UTC に E-STO-OK / E-URL-STORAGE を記録しているのに、
--     10/08 時点で実体が無く resume_url も null。経歴書自体は 9/28〜10/07 に12回届いていた
--
-- ■ 直し方
--   年齢を `greatest(created_at, updated_at)` で測る。
--   保持日数の意味が「最初に受け取ってから」→「**最後に受け取ってから**」に変わる。
--   人材行の寿命（`inbound-email` が再送のたびに created_at を now() に更新する）と揃う。
--
-- ■ 容量への影響（何を守るか・測った数字）
--   守る対象は Storage の Free 枠 1GB。実測 524MB（51%・2026-09-30）、`resumes/` は 2,329件。
--   この変更で延命するのは「今も再送されている」636件だけで、再送が止まれば7日で消える。
--   人材行と同じ窓で頭打ちになるので、青天井にはならない。
--   増えすぎたら `storage_retention_days` を下げれば効く（デプロイ不要）。

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
    -- ⚠ created_at だけで切らないこと。内容ハッシュ名＋upsert では created_at が動かないので、
    --   今日上がり直したファイルを「7日前のもの」として消してしまう（2026-10-08・427人で実害）。
    and greatest(o.created_at, coalesce(o.updated_at, o.created_at)) < p_cutoff
  order by greatest(o.created_at, coalesce(o.updated_at, o.created_at)) asc
  limit least(greatest(coalesce(p_limit, 500), 1), 2000)
$$;

comment on function public.list_old_storage_objects(text, text, timestamptz, int) is
  '保持期間を過ぎた Storage オブジェクトのパス。cleanup-storage が削除対象を引くのに使う。'
  ' 年齢は greatest(created_at, updated_at) で測る＝「最後に受け取ってから」。'
  ' created_at だけで切ると、内容ハッシュ名への upsert で created_at が動かないため'
  ' 再送され続けている経歴書ほど先に消える（2026-10-08・427人で実害）。';

revoke all on function public.list_old_storage_objects(text, text, timestamptz, int) from public, anon;
grant execute on function public.list_old_storage_objects(text, text, timestamptz, int) to service_role;
