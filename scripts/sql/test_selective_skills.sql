-- selective_skills（汎用スキルを資格判定から外す）のテスト（2026-10-10）
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_selective_skills.sql
-- 期待: 「結果」列が全て PASS。
--
-- なぜ要るか:
--   2026-10-10 まで `lower(trim(m.name)) = lower(trim(s))` で**正式名の完全一致**しか
--   見ておらず、案件に**別名で書かれた汎用スキル**が汎用と判定されずに資格判定に残っていた。
--   「クラウド上での開発」（=「クラウド開発」の別名・汎用）だけで候補資格が決まると、
--   61.4% の人材が技術要件を1つも満たさないまま候補に残る。
--   Issue #189 の対応で別名経由の要件が実際に入ってくるので、ここを縛る。
--
-- 仕様:
--   ・汎用スキルを除いた配列を返す
--   ・**全部が汎用なら元の配列をそのまま返す**（候補が空になるのを防ぐ）
--   ・配点には影響しない（汎用スキルの合致も従来どおり加点される）

WITH cases(input, expected, why) AS (VALUES
  (ARRAY['C#', 'クラウド上での開発'], ARRAY['C#'],
   '別名で書かれた汎用スキルも外す（2026-10-10 に直した本体）'),
  (ARRAY['C#', 'クラウド開発'], ARRAY['C#'],
   '正式名で書かれた場合（従来から動いていた）'),
  (ARRAY['クラウド上での開発'], ARRAY['クラウド上での開発'],
   '全部が汎用なら元の配列を返す＝クラウド経験者が候補になる'),
  (ARRAY['C#', 'Java'], ARRAY['C#', 'Java'],
   '技術名は充足率が高くても汎用にしない'),
  (ARRAY['C#', 'ローコード開発'], ARRAY['C#', 'ローコード開発'],
   'ローコード開発は 4.1% なので汎用ではない（絞り込みとして機能する）'),
  (ARRAY[]::text[], ARRAY[]::text[],
   '空配列で落ちない')
),
result AS (
  SELECT input, expected, why, selective_skills(input) AS actual FROM cases
)
SELECT CASE WHEN COALESCE(actual, ARRAY[]::text[]) = expected THEN 'PASS' ELSE '★FAIL' END AS 結果,
       array_to_string(input, ' / ')    AS 必須スキル,
       array_to_string(expected, ' / ') AS 期待,
       array_to_string(actual, ' / ')   AS 実際,
       why                              AS 理由
  FROM result
 ORDER BY (COALESCE(actual, ARRAY[]::text[]) = expected), 必須スキル;
