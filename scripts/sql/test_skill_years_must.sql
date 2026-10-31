-- スキル年数・居住地のマスト（2026-10-31）の部品テスト。DB を書き換えない。
-- 使い方: npx supabase db query --linked -f scripts/sql/test_skill_years_must.sql
-- 結果の failed が空なら全部通っている（`supabase db query -f` は最後の文の結果だけを返す）
WITH t(name, got, want) AS (VALUES
  -- 年数を見る対象（技術だけ）
  ('tech: Java',                      skill_is_tech('Java'), true),
  ('tech: C#.NET は C# として技術',     skill_is_tech('C#.NET'), true),
  ('tech: 基本設計は工程',              skill_is_tech('基本設計'), false),
  ('tech: テストは工程',                skill_is_tech('テスト'), false),
  ('tech: 英語は見ない',                skill_is_tech('英語'), false),
  ('tech: マスタに無い文は見ない',       skill_is_tech('クラウド上での開発経験'), false),
  ('canon: C#.NET は C# に寄る',        skill_canon('C#.NET') = 'c#', true),
  -- 年数が取れているか
  ('meets: Java 96か月 ≧ 0',            skill_years_meets('{"Java":96}', 'Java', 0), true),
  ('meets: Java 96か月 < 10年',          skill_years_meets('{"Java":96}', 'Java', 120), false),
  ('meets: Java 120か月 ≧ 10年',         skill_years_meets('{"Java":120}', 'Java', 120), true),
  ('meets: C# の年数で C#.NET を満たす',  skill_years_meets('{"C#":24}', 'C#.NET', 0), true),
  ('meets: Java8 は Java',              skill_years_meets('{"Java8":60}', 'Java', 0), true),
  ('meets: JavaScript は Java ではない',  skill_years_meets('{"JavaScript":60}', 'Java', 0), false),
  ('meets: C# は C ではない',             skill_years_meets('{"C#":60}', 'C', 0), false),
  ('meets: 0か月は取れていない',          skill_years_meets('{"Java":0}', 'Java', 0), false),
  ('meets: 内部キーは見ない',             skill_years_meets('{"_totalProjectMonths":100}', 'Java', 0), false),
  ('meets: null の skillYears',          skill_years_meets(NULL, 'Java', 0), false),
  ('meets: 配列の skillYears は読まない',  skill_years_meets('[1,2]', 'Java', 0), false),
  -- 案件が年数を書いた技術の足切り
  ('gate: Java 10年以上に 120か月',       skill_years_gate_ok('{"Java":120}', '{"Java":[10]}'), true),
  ('gate: Java 10年以上に 119か月',       skill_years_gate_ok('{"Java":119}', '{"Java":[10]}'), false),
  ('gate: 年数が取れていない人は落ちる',   skill_years_gate_ok('{}', '{"Java":[10]}'), false),
  ('gate: skillYears が null でも落ちる',  skill_years_gate_ok(NULL, '{"Java":[10]}'), false),
  ('gate: 工程の年数は見ない',            skill_years_gate_ok(NULL, '{"テスト":[1],"要件定義":[1]}'), true),
  ('gate: 複数書いてあれば短い方',         skill_years_gate_ok('{"Java":84}', '{"Java":[7,10]}'), true),
  ('gate: 空配列は指定なし',              skill_years_gate_ok('{}', '{"Java":[]}'), true),
  ('gate: 指定なし',                     skill_years_gate_ok('{}', '{}'), true),
  ('gate: 2つとも要る',                   skill_years_gate_ok('{"Java":120}', '{"Java":[5],"Python":[3]}'), false),
  -- 勤務地の縛り（居住地が分からない人は通さない）
  ('loc: 同一県',                        location_gate_ok(true, false, '大阪', '大阪府', '大阪'), true),
  ('loc: 同一地方',                      location_gate_ok(true, false, '大阪', '兵庫県', '兵庫'), true),
  ('loc: 別地方',                        location_gate_ok(true, false, '大阪', '東京都', '東京'), false),
  ('loc: 居住地不明は通さない',            location_gate_ok(true, false, '大阪', '', ''), false),
  ('loc: 居住地 null も通さない',          location_gate_ok(true, false, '大阪', NULL, NULL), false),
  ('loc: フルリモートは縛らない',          location_gate_ok(true, true, '大阪', '', ''), true),
  ('loc: 縛りを外せば通す',               location_gate_ok(false, false, '大阪', '', ''), true),
  ('loc: 案件の県が不明なら縛らない',      location_gate_ok(true, false, '客先（詳細は面談時）', '', ''), true),
  ('loc: 駅名から県を補える（妙典or行徳）', resolve_work_prefecture('妙典or行徳') = '千葉県', true),
  -- match-batch 用（年数が取れていない技術の組だけ返す）
  ('batch: 年数の無い技術だけ返す',
     (SELECT array_agg(idx || ':' || want ORDER BY idx, want)
        FROM match_unverified_tech_batch('[{"Java":12},{}]', ARRAY['Java', '基本設計']))::text = '{1:Java}',
     true)
)
SELECT json_build_object(
  'total', count(*),
  'failed', COALESCE(json_agg(json_build_object('name', name, 'got', got::text, 'want', want::text))
                     FILTER (WHERE got::text IS DISTINCT FROM want::text), '[]'::json)
) AS result
FROM (SELECT name, got::text AS got, want::text AS want FROM t) t;
