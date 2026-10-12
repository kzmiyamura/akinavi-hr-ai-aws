-- 勤務地の縛りのテスト（2026-10-12・ユーザー判断「フルリモートでない限り勤務地縛り100」）
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_location_gate.sql
-- 期待: 「結果」列が全て PASS。
--
-- 守りたいこと:
--   ① 大阪の案件に関西外の人が入らない
--   ② 同一地方（兵庫・京都から淀屋橋）は残る
--   ③ 居住地が取れていない人を落とさない（prod 実測 3.3%）
--   ④ フルリモート案件では縛らない
--   ⑤ 案件の都道府県が取れていない案件では縛らない（比べる相手が無い）
--   ⑥ p_location_gate=false で従来どおりになる
--
-- 案件は Issue #187/#188 の「販売管理システム（C#・VB.NET）」（大阪府 淀屋橋・出社）。

WITH
-- 縛りあり（既定）
gated AS (
  SELECT COALESCE(f.raw_profile->>'prefecture', '') AS pref
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['基本設計','C#.NET']::text[],
      NULL::numeric, 75::numeric, '大阪府 淀屋橋'::text, '出社'::text, 500,
      35, 15, 25, 20, 5, false, NULL::text, '大阪府'::text, NULL::integer,
      '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[], NULL::text, 30, true) f
),
-- 縛りなし（従来）
ungated AS (
  SELECT COALESCE(f.raw_profile->>'prefecture', '') AS pref
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['基本設計','C#.NET']::text[],
      NULL::numeric, 75::numeric, '大阪府 淀屋橋'::text, '出社'::text, 500,
      35, 15, 25, 20, 5, false, NULL::text, '大阪府'::text, NULL::integer,
      '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[], NULL::text, 30, false) f
),
-- 同じ案件をフルリモートにしたら縛らない
remote AS (
  SELECT COALESCE(f.raw_profile->>'prefecture', '') AS pref
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['基本設計','C#.NET']::text[],
      NULL::numeric, 75::numeric, '大阪府 淀屋橋'::text, 'フルリモート'::text, 500,
      35, 15, 25, 20, 5, false, NULL::text, '大阪府'::text, NULL::integer,
      '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[], NULL::text, 30, true) f
),
-- 案件の都道府県が取れていない（勤務地の文字列も県名を含まない）
nopref AS (
  SELECT COALESCE(f.raw_profile->>'prefecture', '') AS pref
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['基本設計','C#.NET']::text[],
      NULL::numeric, 75::numeric, '客先（詳細は面談時）'::text, '出社'::text, 500,
      35, 15, 25, 20, 5, false, NULL::text, NULL::text, NULL::integer,
      '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[], NULL::text, 30, true) f
),
kansai(p) AS (VALUES ('大阪府'),('京都府'),('兵庫県'),('奈良県'),('滋賀県'),('和歌山県')),
m AS (
  SELECT
    (SELECT count(*) FROM gated)                                              AS g_all,
    (SELECT count(*) FROM gated WHERE pref = '大阪府')                         AS g_osaka,
    (SELECT count(*) FROM gated
      WHERE pref <> '' AND pref <> '大阪府' AND pref IN (SELECT p FROM kansai)) AS g_kansai,
    (SELECT count(*) FROM gated WHERE pref = '')                               AS g_unknown,
    (SELECT count(*) FROM gated
      WHERE pref <> '' AND pref NOT IN (SELECT p FROM kansai))                 AS g_outside,
    (SELECT count(*) FROM ungated)                                             AS u_all,
    (SELECT count(*) FROM ungated
      WHERE pref <> '' AND pref NOT IN (SELECT p FROM kansai))                 AS u_outside,
    (SELECT count(*) FROM remote)                                              AS r_all,
    (SELECT count(*) FROM nopref)                                              AS n_all
),
cases(no, label, ok, detail) AS (
  SELECT 1, '① 関西外の人が候補に入らない', g_outside = 0,
         '関西外 ' || g_outside || '人'                                    FROM m
  UNION ALL
  SELECT 2, '② 大阪府の人は残る', g_osaka > 0, '大阪 ' || g_osaka || '人'   FROM m
  UNION ALL
  SELECT 3, '③ 同一地方（関西の他県）も残る', g_kansai > 0,
         '関西他 ' || g_kansai || '人'                                     FROM m
  UNION ALL
  SELECT 4, '④ 居住地不明を落としていない', g_unknown > 0,
         '不明 ' || g_unknown || '人（0 なら縛りが不明も落としている）'      FROM m
  UNION ALL
  SELECT 5, '⑤ 縛ると候補が減る', g_all < u_all,
         u_all || '人 → ' || g_all || '人'                                 FROM m
  UNION ALL
  SELECT 6, '⑥ 縛りなしでは関西外が入る（従来どおり）', u_outside > 0,
         '関西外 ' || u_outside || '人'                                    FROM m
  UNION ALL
  SELECT 7, '⑦ フルリモート案件では縛らない', r_all = u_all,
         'フルリモート ' || r_all || '人 / 縛りなし ' || u_all || '人'       FROM m
  UNION ALL
  SELECT 8, '⑧ 案件の都道府県が不明なら縛らない', n_all = u_all,
         '県不明 ' || n_all || '人 / 縛りなし ' || u_all || '人'            FROM m
  -- ▼ 都道府県の切り出し（2026-10-12 に実測で壊れていた2件）
  --   最短一致 `(\S+?)[都道府県]` は「京都府」→「京」・「北海道」→「北海」になる。
  --   get_region が NULL を返すので、prod の京都5人・北海道12人は自分の県の案件でも
  --   勤務地0点で、縛りを入れると候補から消えていた。
  UNION ALL
  SELECT 9, '⑨ 京都府の核が「京都」', extract_pref_core('京都府') = '京都',
         '→ ' || extract_pref_core('京都府')
  UNION ALL
  SELECT 10, '⑩ 東京都の核が「東京」（京都に食われない）', extract_pref_core('東京都') = '東京',
         '→ ' || extract_pref_core('東京都')
  UNION ALL
  SELECT 11, '⑪ 北海道の核が「北海道」', extract_pref_core('北海道') = '北海道',
         '→ ' || extract_pref_core('北海道')
  UNION ALL
  SELECT 12, '⑫ 京都市の表記でも「京都」', extract_pref_core('京都市中京区') = '京都',
         '→ ' || extract_pref_core('京都市中京区')
  UNION ALL
  SELECT 13, '⑬ 京都の案件に京都の人材が通る',
         location_gate_ok(true, false, work_pref_core('京都府', NULL),
                          '京都府', extract_pref_core('京都府')),
         '京都→京都'
  UNION ALL
  SELECT 14, '⑭ 京都の案件に大阪の人材が通る（同じ近畿）',
         location_gate_ok(true, false, work_pref_core('京都府', NULL),
                          '大阪府', extract_pref_core('大阪府')),
         '大阪→京都'
  UNION ALL
  SELECT 15, '⑮ 京都の案件に東京の人材は通らない',
         NOT location_gate_ok(true, false, work_pref_core('京都府', NULL),
                              '東京都', extract_pref_core('東京都')),
         '東京→京都'
  UNION ALL
  SELECT 16, '⑯ 北海道の案件に北海道の人材が通る',
         location_gate_ok(true, false, work_pref_core('北海道', NULL),
                          '北海道', extract_pref_core('北海道')),
         '北海道→北海道'
)
SELECT CASE WHEN ok THEN 'PASS' ELSE '★FAIL' END AS 結果,
       no AS "#", label AS 確認したこと, detail AS 実測
  FROM cases
 ORDER BY ok, no;
