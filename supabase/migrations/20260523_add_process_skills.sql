-- 工程系スキルを skill_master に追加
-- 案件の必須スキル欄に頻出する工程・経験語

INSERT INTO skill_master (name, category, aliases) VALUES
  ('テスト', 'methodologies', '["テスト","テスト経験","test","testing","QA","品質確認","検証"]'),
  ('保守開発', 'methodologies', '["保守開発","保守・開発","メンテナンス開発","maintenance"]'),
  ('保守運用', 'methodologies', '["保守運用","運用保守","保守・運用","運用・保守"]'),
  ('調査分析', 'methodologies', '["調査分析","調査・分析","分析・調査"]')
ON CONFLICT (name) DO NOTHING;
