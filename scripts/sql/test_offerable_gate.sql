-- 「今うちから出せる人だけ」の縛りのテスト（2026-10-20 営業の指示「ボタンをおけ」）
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_offerable_gate.sql
-- 期待: 「結果」列が全て PASS。
--
-- 守りたいこと:
--   ① 縛りあり（既定）で返る人は全員 自社or1社先 × 経歴書あり × 稼働が今日以前
--   ② 縛りなし（p_offerable_only=false）にすると人数が増える（従来どおり）
--   ③ 縛りありの集合は縛りなしの部分集合（順位の式は変えていない）
--   ④ 判定関数が NULL を返さない（未取得は false）
--
-- 案件は test_location_gate.sql と同じ「販売管理システム（C#・VB.NET）」（大阪府 淀屋橋・出社）。

WITH
gated AS (
  SELECT f.id,
         flow_bucket(f.raw_profile->>'commercialFlow') AS flow,
         (f.resume_url IS NOT NULL OR f.drive_url IS NOT NULL OR f.box_url IS NOT NULL) AS has_resume,
         parse_available_from(f.raw_profile->>'availableFrom') AS avail
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['基本設計','C#.NET']::text[],
      NULL::numeric, 75::numeric, '大阪府 淀屋橋'::text, '出社'::text, 500,
      35, 15, 25, 20, 5, false, NULL::text, '大阪府'::text, NULL::integer,
      '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[], NULL::text, 30, true, true) f
),
ungated AS (
  SELECT f.id
    FROM fetch_candidates_for_project(
      'prod'::text, ARRAY['基本設計','C#.NET']::text[],
      NULL::numeric, 75::numeric, '大阪府 淀屋橋'::text, '出社'::text, 500,
      35, 15, 25, 20, 5, false, NULL::text, '大阪府'::text, NULL::integer,
      '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[], NULL::text, 30, true, false) f
)
SELECT '① 縛りありは全員が出せる人' AS 検査,
       CASE WHEN NOT EXISTS (SELECT 1 FROM gated
                             WHERE flow NOT IN ('自社','1社先') OR flow IS NULL
                                OR NOT has_resume OR avail IS NULL OR avail > current_date)
            THEN 'PASS' ELSE 'FAIL' END AS 結果,
       (SELECT count(*) FROM gated)::text AS 値
UNION ALL
SELECT '② 縛りなしは人数が増える',
       CASE WHEN (SELECT count(*) FROM ungated) > (SELECT count(*) FROM gated) THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(*) FROM ungated)::text
UNION ALL
SELECT '③ 縛りありは縛りなしの部分集合',
       CASE WHEN NOT EXISTS (SELECT 1 FROM gated g WHERE g.id NOT IN (SELECT id FROM ungated))
            THEN 'PASS' ELSE 'FAIL' END,
       '-'
UNION ALL
SELECT '④ 未取得は NULL でなく false',
       CASE WHEN offerable_ok(true, NULL, true, current_date) IS FALSE
             AND offerable_ok(true, '自社', NULL, current_date) IS FALSE
             AND offerable_ok(true, '自社', true, NULL) IS FALSE
            THEN 'PASS' ELSE 'FAIL' END,
       '-';
