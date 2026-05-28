-- station_master 補完: 取り込みログ [station_unmapped] で発見した未登録駅を追加
-- 西葛西・南砂町（東京メトロ東西線）など、初期シードで抜けていた主要駅を補う

INSERT INTO station_master (name, prefecture) VALUES
('西葛西', '東京都'),
('南砂町', '東京都')
ON CONFLICT (name) DO NOTHING;
