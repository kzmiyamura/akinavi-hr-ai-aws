-- 画面表示用 match_skill_strings の確認（2026-08-12）
--
-- マッチング画面は候補者スキル×必須スキルの一致組をこのRPCで取る。
-- 配点（skill_hit_weights）と同じ判定になっていないと、点が入っていないのに緑で出る。
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_match_skill_strings.sql
-- 期待: 結果が PASS

WITH have(s) AS (VALUES ('Java'), ('JavaScript'), ('MySQL'), ('Shell'), ('Spring'), ('C')),
want(q) AS (VALUES ('Java'), ('SQL'), ('PowerShell'), ('Spring Boot'), ('C#')),
got AS (SELECT have, want FROM match_skill_strings(
          ARRAY(SELECT s FROM have), ARRAY(SELECT q FROM want))),
expected(have, want) AS (VALUES
  ('Java',  'Java'),   -- 完全一致
  ('MySQL', 'SQL')     -- 包含関係
  -- JavaScript→Java / Shell→PowerShell / Spring→Spring Boot / C→C# は一致しない
),
cmp AS (
  SELECT
    (SELECT count(*) FROM got) AS 実際の組数,
    (SELECT count(*) FROM expected) AS 期待の組数,
    (SELECT count(*) FROM got WHERE NOT EXISTS (
       SELECT 1 FROM expected e WHERE e.have = got.have AND e.want = got.want)) AS 余分,
    (SELECT count(*) FROM expected e WHERE NOT EXISTS (
       SELECT 1 FROM got WHERE got.have = e.have AND got.want = e.want)) AS 不足
)
SELECT CASE WHEN 余分 = 0 AND 不足 = 0 THEN 'PASS' ELSE '★FAIL' END AS 結果, *
  FROM cmp;
