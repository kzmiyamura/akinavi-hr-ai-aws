-- 汎用スキルの判定が「別名で書かれた必須スキル」にも効くことを縛る（2026-10-10）
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_selective_skills_alias.sql
-- 期待: 「結果」列が全て PASS。
-- 兄弟: test_selective_skills.sql（汎用スキルの扱いそのものと RPC の候補集合の一致）
--
-- なぜ要るか:
--   2026-10-10 まで selective_skills は `lower(trim(m.name)) = lower(trim(s))` で
--   **正式名の完全一致**しか見ておらず、案件に**別名で書かれた汎用スキル**が
--   汎用と判定されずに資格判定へ残っていた。
--   Issue #189 で「クラウド上での開発」（=「クラウド開発」の別名・汎用）が
--   実際に要件として入ってくるため、素通りすると 61.4% の人材が技術要件を
--   1つも満たさないまま候補に残る。

WITH cases(input, expected, why) AS (VALUES
  (ARRAY['C#', 'クラウド上での開発'], ARRAY['C#'],
   '別名で書かれた汎用スキルも外す（2026-10-10 に直した本体）'),
  (ARRAY['C#', 'クラウド開発'], ARRAY['C#'],
   '正式名で書かれた場合（従来から動いていた）'),
  (ARRAY['PowerShell', '結合テスト'], ARRAY['PowerShell'],
   '「テスト」の別名。別名対応で新たに外れるようになった'),
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
  -- 戻り順は保証されないが、selective_skills は入力順を保つ実装なので
  -- 期待値も入力順で書いている（並べ替えると「どれが落ちたか」が読めなくなる）
  SELECT input, expected, why, selective_skills(input) AS actual FROM cases
)
SELECT CASE WHEN COALESCE(actual, ARRAY[]::text[]) = expected THEN 'PASS' ELSE '★FAIL' END AS 結果,
       array_to_string(input, ' / ')    AS 必須スキル,
       array_to_string(expected, ' / ') AS 期待,
       array_to_string(actual, ' / ')   AS 実際,
       why                              AS 理由
  FROM result
 ORDER BY (COALESCE(actual, ARRAY[]::text[]) = expected), 必須スキル;
