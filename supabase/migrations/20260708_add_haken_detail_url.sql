-- 厚労省「人材サービス総合サイト」の派遣許可番号詳細ページへの直接リンクを保存するカラム。
--
-- 経緯: 詳細ページURLの末尾にある事業所インデックス（例: 派13-070203,0 / 派13-317351,1）は
-- 同一許可番号を持つ複数事業所（本店・支店等）のうちどれを表示するかを示す値で、番号ごとに
-- 異なり固定値では推測できない。verify-agent-license の検索結果HTML内には、サイト自身が
-- 生成した正しいインデックス付きのリンク（<a id="ID_linkKyokatodokedeNo" href="...">）が
-- 既に含まれているため、それをそのまま抽出・保存してフロントエンドで利用する。
alter table public.agent_companies
  add column if not exists haken_detail_url text;

comment on column public.agent_companies.haken_detail_url is
  '厚労省「人材サービス総合サイト」の許可番号詳細ページへの完全なURL（verify-agent-license が検索結果HTMLから抽出）';
