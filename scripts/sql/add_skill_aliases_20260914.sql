-- 品質チェックSQLが見つけた「skill_master に無いスキル」を別名として足す（2026-09-14）。
--
--   windows10 (47件) / windows11 (37件) / vb 6.0 (3件)
--
-- ■ 新規行を作らない
--   いずれも既存行の表記ゆれ。新しい行を作ると canon を奪って既存の一致が壊れる
--   （前例: 2026-08 に28人→1人になった）。**既存行の aliases に足す**のが正しい。
--     Windows        既に "Windows 10" / "Windows 11"（スペースあり）を持っていた
--                    → 検出されたのはスペース無しの "windows10" / "windows11"
--     Visual Basic   既に "VB6" / "VB6.0" を持っていた
--                    → 検出されたのはスペース入りの "vb 6.0"
--
-- ■ 副作用
--   skill_master を更新すると skill_norm_map（マテビュー）がトリガで貼り直される。
--   マッチングのスキル一致判定はそれを見るので、反映は自動。

update skill_master
   set aliases = (
     select jsonb_agg(distinct v)
     from jsonb_array_elements_text(aliases || '["windows10","windows11"]'::jsonb) as t(v)
   )
 where name = 'Windows'
   and not (aliases @> '["windows10"]'::jsonb and aliases @> '["windows11"]'::jsonb);

update skill_master
   set aliases = (
     select jsonb_agg(distinct v)
     from jsonb_array_elements_text(aliases || '["vb 6.0"]'::jsonb) as t(v)
   )
 where name = 'Visual Basic'
   and not (aliases @> '["vb 6.0"]'::jsonb);

-- 確認用
select name, aliases, match_count
  from skill_master
 where name in ('Windows', 'Visual Basic')
 order by name;
