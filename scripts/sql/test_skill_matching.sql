-- スキル一致判定のテスト（2026-08-12）
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_skill_matching.sql
-- 期待: 「結果」列が全て PASS。1つでも FAIL があれば判定が壊れている。
--
-- ケースは実データで起きていた誤判定から作っている（prod 人材2,007件の実測より）。

WITH cases(have, want, expected, why) AS (VALUES
  -- ▼ 落とすべき（変更前は全て一致してしまっていた）
  ('JavaScript',  'Java',            false, 'JavaScript は Java ではない（983人が誤一致）'),
  ('C',           'C#',              false, 'C言語 は C# ではない（399人が誤一致）'),
  ('C',           'Azure Functions', false, '逆方向の部分一致。azure functions が %c% を含む'),
  ('C',           'Microsoft 365',   false, '同上'),
  ('R',           'Spring Boot',     false, '1文字スキルがほぼ全要件に一致していた'),
  ('ROS',         'Microsoft 365',   false, 'mic-ROS-oft への誤一致（38人）'),
  ('Shell',       'PowerShell',      false, 'Shell は PowerShell ではない（329人が誤一致）'),
  ('Spring',      'Spring Boot',     false, 'Spring だけの人は Boot 要件を満たさない（2026-08-12 ユーザー判断）'),
  ('SQLAlchemy',  'SQL',             false, 'Python の ORM。SQL 経験とはみなさない'),
  ('Java',        'JavaScript',      false, '逆向きも成り立たない'),
  ('SQL',         'MySQL',           false, '包含関係は一方向。SQL経験者がMySQL要件を満たすとは限らない'),

  -- ▼ 一致すべき
  ('Java',        'Java',            true,  '完全一致'),
  ('java',        'JAVA',            true,  '大小文字を無視する'),
  ('Java8',       'Java',            true,  '末尾のバージョン番号を落として解決する'),
  ('Oracle Java SE','Java',          true,  '語として Java を含む'),
  ('C#.NET',      'C#',              true,  '語として C# を含む（. は語の区切り）'),
  ('JS',          'JavaScript',      true,  'skill_master の別名で正規化する'),
  ('Entra ID',    'EntraID',         true,  '空白の有無を吸収する（5人→37人に増えた分）'),
  ('Spring Boot', 'Spring',          true,  'Boot 経験者は Spring 要件を満たす'),
  ('MySQL',       'SQL',             true,  '包含関係。RDBMS経験はSQL要件を満たす（2026-08-12 ユーザー判断）'),
  ('PostgreSQL',  'SQL',             true,  '同上'),
  ('Oracle',      'SQL',             true,  '別名 Oracle → Oracle Database → 包含関係で SQL'),
  ('PL/SQL',      'SQL',             true,  '語として SQL を含む'),
  ('T-SQL',       'SQL',             true,  '同上'),
  ('SQL Server',  'SQL',             true,  '同上'),
  ('単体テスト',   'テスト',           true,  'skill_master の別名'),
  ('MongoDB',     'SQL',             false, 'NoSQL は SQL 要件を満たさない'),
  ('S3',          'S',               false, 'バージョン番号剥がしで S3→S にしてはいけない')
),
result AS (
  SELECT have, want, expected, why,
         skill_satisfies(have, want) AS actual
    FROM cases
)
SELECT CASE WHEN actual = expected THEN 'PASS' ELSE '★FAIL' END AS 結果,
       have AS 候補者スキル, want AS 必須スキル,
       expected AS 期待, actual AS 実際, why AS 理由
  FROM result
 ORDER BY (actual = expected), want, have;
