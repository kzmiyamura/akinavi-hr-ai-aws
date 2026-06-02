-- パフォーマンスチューニングを skill_master に追加
-- 案件の <尚可> 等で頻出するが未登録だったため、スキル照合で拾えていなかった

INSERT INTO skill_master (name, category, aliases, source) VALUES
('パフォーマンスチューニング', 'others', '["performance tuning","性能チューニング","性能改善","パフォーマンス改善","パフォーマンス最適化"]'::jsonb, 'seed')
ON CONFLICT (name) DO NOTHING;
