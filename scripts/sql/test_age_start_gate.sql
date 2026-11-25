-- #192 年齢の上限・稼働を案件の開始日で比べる の確認（本番 DB で読むだけ）
-- 実行: npx supabase db query --linked -f scripts/sql/test_age_start_gate.sql
-- 全行 ok=true なら合格
WITH t(name, got, expect) AS (VALUES
  ('43歳以下 → 43',            required_age_max(ARRAY['COBOL','IBM','43歳以下'])::text, '43'),
  ('50歳未満 → 49',            required_age_max(ARRAY['SQL','50歳未満','日本国籍'])::text, '49'),
  ('全角 ４５歳まで → 45',      required_age_max(ARRAY['４５歳まで'])::text, '45'),
  ('40代まで → 49',            required_age_max(ARRAY['40代まで'])::text, '49'),
  ('2つあれば厳しい方',         required_age_max(ARRAY['50歳以下','45歳以下'])::text, '45'),
  ('年齢の無い案件 → NULL',     COALESCE(required_age_max(ARRAY['Java','基本設計'])::text, 'NULL'), 'NULL'),
  ('空配列 → NULL',            COALESCE(required_age_max(ARRAY[]::text[])::text, 'NULL'), 'NULL'),
  ('「43歳以上」は上限ではない', COALESCE(required_age_max(ARRAY['43歳以上'])::text, 'NULL'), 'NULL'),
  ('上限なし → 年齢不明も通す', age_gate_ok(NULL, NULL)::text, 'true'),
  ('43以下に43歳 → 通す',       age_gate_ok(43, '43')::text, 'true'),
  ('43以下に44歳 → 外す',       age_gate_ok(43, '44')::text, 'false'),
  ('43以下に年齢不明 → 外す',   age_gate_ok(43, NULL)::text, 'false'),
  ('43以下に「三十代」→ 外す',  age_gate_ok(43, '三十代')::text, 'false'),
  ('開始日12/1・稼働12/1 → 通す',
     offerable_ok(true, '1社先', true, current_date + 6, current_date + 6)::text, 'true'),
  ('開始日12/1・稼働1/1 → 外す',
     offerable_ok(true, '1社先', true, current_date + 37, current_date + 6)::text, 'false'),
  ('開始日なし・稼働来月 → 外す（従来どおり）',
     offerable_ok(true, '自社', true, current_date + 20, NULL)::text, 'false'),
  ('開始日が過去 → 今日で比べる',
     offerable_ok(true, '自社', true, current_date + 1, current_date - 30)::text, 'false'),
  ('4引数版は今日で比べる（人材マップ）',
     offerable_ok(true, '自社', true, current_date + 1)::text, 'false'),
  ('4引数版・即日 → 通す',      offerable_ok(true, '自社', true, current_date)::text, 'true'),
  ('経歴書なしは開始日に関係なく外す',
     offerable_ok(true, '1社先', false, current_date, current_date + 6)::text, 'false')
)
SELECT name, got, expect, got = expect AS ok FROM t;
