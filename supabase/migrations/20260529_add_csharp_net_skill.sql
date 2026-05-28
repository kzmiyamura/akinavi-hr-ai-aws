-- C#.NET を C# とは別のスキルとして skill_master に追加する
-- inbound-email のスキル照合は C# のパターンに「直後が . の場合は不一致」
-- という否定先読みがあるため、"C#.net" は C# にマッチせず、C#.NET（本エントリ）にのみマッチする。
-- これにより C#（汎用）と C#.NET（.NET 限定）を明確に分離できる。

INSERT INTO skill_master (name, category, aliases, source) VALUES
('C#.NET', 'languages', '["csharp.net","c#.net","c sharp .net"]'::jsonb, 'seed')
ON CONFLICT (name) DO NOTHING;
