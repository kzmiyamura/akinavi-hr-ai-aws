-- Issue #66: 川間駅を千葉県に修正
INSERT INTO station_master (name, prefecture)
VALUES ('川間', '千葉県')
ON CONFLICT (name) DO UPDATE SET prefecture = EXCLUDED.prefecture;

-- 既存の候補者で川間駅→岩手県になっているレコードを千葉県に修正
UPDATE candidates
SET raw_profile = jsonb_set(raw_profile, '{prefecture}', '"千葉県"')
WHERE raw_profile->>'nearestStation' ILIKE '%川間%'
  AND raw_profile->>'prefecture' = '岩手県'
  AND data_env = 'prod';

-- Issue #70: 不足駅を追加
INSERT INTO station_master (name, prefecture) VALUES
  ('秋津', '東京都'),
  ('京王よみうりランド', '東京都'),
  ('多摩センター', '東京都'),
  ('稲城', '東京都'),
  ('矢野口', '東京都'),
  ('是政', '東京都'),
  ('白糸台', '東京都'),
  ('競艇場前', '東京都'),
  ('南多摩', '東京都'),
  ('府中本町', '東京都'),
  ('北府中', '東京都'),
  ('西府', '東京都'),
  ('分倍河原', '東京都'),
  ('聖蹟桜ヶ丘', '東京都'),
  ('百草園', '東京都'),
  ('高幡不動', '東京都'),
  ('南平', '東京都'),
  ('平山城址公園', '東京都'),
  ('長沼', '東京都'),
  ('北野', '東京都'),
  ('八千代中央', '千葉県'),
  ('八千代緑が丘', '千葉県'),
  ('勝田台', '千葉県'),
  ('村上', '千葉県'),
  ('東葉勝田台', '千葉県'),
  ('大網', '千葉県'),
  ('茂原', '千葉県'),
  ('長者町', '千葉県'),
  ('八積', '千葉県'),
  ('上総一ノ宮', '千葉県'),
  ('東金', '千葉県'),
  ('求名', '千葉県'),
  ('福俵', '千葉県'),
  ('成東', '千葉県'),
  ('横芝', '千葉県'),
  ('松尾', '千葉県'),
  ('八日市場', '千葉県'),
  ('飯岡', '千葉県'),
  ('倉橋', '千葉県'),
  ('猿田', '千葉県'),
  ('松岸', '千葉県'),
  ('銚子', '千葉県'),
  ('笹川', '千葉県'),
  ('下総神崎', '千葉県'),
  ('大戸', '千葉県'),
  ('佐原', '千葉県'),
  ('香取', '千葉県'),
  ('水郷', '千葉県'),
  ('十二橋', '千葉県'),
  ('潮来', '茨城県'),
  ('延方', '茨城県'),
  ('鹿島神宮', '茨城県'),
  ('鹿島大野', '茨城県'),
  ('荒野台', '茨城県'),
  ('鹿島サッカースタジアム', '茨城県')
ON CONFLICT (name) DO NOTHING;

-- Issue #71: AS/400, IBMi等をskill_masterに追加
INSERT INTO skill_master (name, category, aliases, source) VALUES
  ('AS/400', 'others', '["AS400", "AS／400"]'::jsonb, 'seed'),
  ('IBMi', 'others', '["IBM i", "IBM iSeries", "iSeries"]'::jsonb, 'seed'),
  ('RPG', 'languages', '["RPGⅢ", "RPGⅣ", "ILE-RPG", "RPG III", "RPG IV", "RPGIII", "RPGIV"]'::jsonb, 'seed'),
  ('RPGⅢ', 'languages', '["RPG III", "RPGIII", "RPG3"]'::jsonb, 'seed'),
  ('RPGⅣ', 'languages', '["RPG IV", "RPGIV", "RPG4"]'::jsonb, 'seed'),
  ('ILE-RPG', 'languages', '["ILE RPG", "ILERPG"]'::jsonb, 'seed')
ON CONFLICT (name) DO NOTHING;
