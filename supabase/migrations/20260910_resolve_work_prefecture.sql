-- 勤務地の文字列から都道府県を解決する関数（2026-09-10・#183）
--
-- 経緯: 画面から案件の勤務地を直しても work_prefecture が更新されなかった。
-- UpdateProjectInput に work_prefecture が無く、**フロントに書く経路が1つも無かった**ため。
-- マッチングは work_prefecture を優先する（src/lib/matchRuleScore.ts:112）ので、
-- 「北新地」を「大阪」に直しても大阪府として扱われないまま残っていた。
-- prod 実測（2026-09-10）: 13案件中3件が空（大手町常駐 / 竹芝出社(週3日)… / 大阪）。
--
-- 駅名で引く必要があるため（北新地→大阪府）、判定はブラウザではなく DB に置く。
-- station_master は 8,443駅・12,666行あり、フロントに同梱するとバンドルが太る。
--
-- 同名駅の扱いは station_master の既定方針に合わせる（CLAUDE.md）:
--   県が1つに定まればそれ、割れたら首都圏を優先、首都圏同士で割れたら null。

create or replace function public.resolve_work_prefecture(p_text text)
returns text
language plpgsql
stable
as $$
declare
  v_text  text := coalesce(p_text, '');
  v_pref  text;
  v_name  text;
  v_capital text[] := ARRAY['東京都','神奈川県','埼玉県','千葉県'];
begin
  if btrim(v_text) = '' then
    return null;
  end if;

  -- ① 都道府県名がそのまま書いてある（「東京都 大手町」「大阪府 新大阪」）。最長一致を採る
  select p into v_pref
  from unnest(ARRAY[
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
    '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
    '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県',
    '三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
    '鳥取県','島根県','岡山県','広島県','山口県',
    '徳島県','香川県','愛媛県','高知県',
    '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'
  ]) p
  where position(p in v_text) > 0
  order by length(p) desc
  limit 1;
  if v_pref is not null then
    return v_pref;
  end if;

  -- ② 駅名で引く。テキストに含まれる**最長**の駅名を採る
  --    （「新大阪」がある文字列で「大阪」を拾わないため）
  select s.name into v_name
  from (select distinct name from station_master where char_length(name) >= 2) s
  where position(s.name in v_text) > 0
  order by char_length(s.name) desc, s.name
  limit 1;

  if v_name is null then
    return null;
  end if;

  -- 同名駅: 県が1つなら確定
  select min(prefecture) into v_pref
  from station_master where name = v_name
  having count(distinct prefecture) = 1;
  if v_pref is not null then
    return v_pref;
  end if;

  -- 割れたときは首都圏を優先。首都圏同士で割れたら決めない
  select min(prefecture) into v_pref
  from station_master
  where name = v_name and prefecture = any(v_capital)
  having count(distinct prefecture) = 1;

  return v_pref;
end;
$$;

comment on function public.resolve_work_prefecture(text) is
  '勤務地の生文字列から都道府県を解決する。都道府県名 → 駅名（最長一致）の順。'
  ' 画面から勤務地を編集したときに work_prefecture を追随させるために使う（#183）。';

revoke all on function public.resolve_work_prefecture(text) from public;
grant execute on function public.resolve_work_prefecture(text) to anon, authenticated, service_role;
