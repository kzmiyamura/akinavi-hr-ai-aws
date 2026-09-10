-- 指定したスキル名のカテゴリを返す関数（2026-09-10・#185）
--
-- 経緯: 画面で必須スキルを直しても skill_weights が再計算されず、
-- 「求める人」と「スキルの重み」が食い違ったまま採点に使われていた。
-- 重みはカテゴリ（言語=4 … 工程語=1）で決まるので、フロントから引けるようにする。
--
-- skill_master 全件（951行）をフロントに引くのは egress の無駄なので、
-- 必要なスキルぶんだけを問い合わせる。表記ゆれ（java / Java）を落とさないよう
-- 突合は小文字化して行う。

create or replace function public.skill_categories(p_names text[])
returns table (name text, category text)
language sql
stable
as $$
  select distinct on (lower(s.name))
         s.name::text, s.category::text
  from skill_master s
  where lower(s.name) = any (
    select lower(n) from unnest(coalesce(p_names, '{}'::text[])) n
  )
  order by lower(s.name), s.match_count desc nulls last
$$;

comment on function public.skill_categories(text[]) is
  '必須スキルの重み（skill_weights）を組み立てるためのカテゴリ引き。大文字小文字を無視して突合する。';

revoke all on function public.skill_categories(text[]) from public;
grant execute on function public.skill_categories(text[]) to anon, authenticated, service_role;
