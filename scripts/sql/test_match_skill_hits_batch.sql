-- match_skill_hits_batch の単体テスト。
-- 旧ルール（双方向部分一致）で誤合致していた実例を固定する。
WITH t AS (
  SELECT * FROM match_skill_hits_batch(
    '[["基本設計","C","Shell","Linux","Perl"],["Java8","Entra ID","MySQL"],["PowerShell","Microsoft 365"]]'::jsonb,
    ARRAY['基本設計','Microsoft 365','PowerShell','EntraID','Azure Functions']
  )
)
SELECT
  '0: SM型（基本設計のみ合致するはず）' AS ケース,
  (SELECT count(*) FROM t WHERE idx = 0)                                   AS 実際,
  1                                                                        AS 期待,
  CASE WHEN (SELECT count(*) FROM t WHERE idx = 0) = 1
       THEN 'PASS' ELSE 'FAIL' END                                         AS 判定,
  (SELECT string_agg(want, ',') FROM t WHERE idx = 0)                      AS 合致内容
UNION ALL
SELECT
  '1: Entra ID の空白ゆれは吸収する',
  (SELECT count(*) FROM t WHERE idx = 1), 1,
  CASE WHEN (SELECT count(*) FROM t WHERE idx = 1) = 1 THEN 'PASS' ELSE 'FAIL' END,
  (SELECT string_agg(want, ',') FROM t WHERE idx = 1)
UNION ALL
SELECT
  '2: 正式名2つはそのまま合致',
  (SELECT count(*) FROM t WHERE idx = 2), 2,
  CASE WHEN (SELECT count(*) FROM t WHERE idx = 2) = 2 THEN 'PASS' ELSE 'FAIL' END,
  (SELECT string_agg(want, ',') FROM t WHERE idx = 2);
