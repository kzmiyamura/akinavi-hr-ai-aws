-- 必須スキルの一致判定がどれだけ緩いかを実測する（2026-08-12）
--
-- 現行 RPC の条件:  lower(s) LIKE '%'||q||'%'  OR  q LIKE '%'||lower(s)||'%'
--   q = 案件の必須スキル（小文字） / s = 候補者スキル
--
-- 何を見るか: prod 案件で実際に使われている必須スキルごとに、
--   ・現行の部分一致で何人ヒットするか
--   ・そのうち「表記ゆれではなく別物」が何人混ざっているか（候補者側の実際の文字列で確認）
-- 出力は「必須スキル × 候補者側の実表記 × 人数」。ここを人間が見て正規化方針を決める。
--
-- 実行: npx supabase db query --linked -f scripts/sql/audit_skill_match_looseness.sql

WITH req AS (
  -- prod 案件が実際に要求している必須スキル（重複除く）
  SELECT DISTINCT lower(trim(s)) AS q
    FROM projects p, jsonb_array_elements_text(p.required_skills) s
   WHERE p.data_env = 'prod'
     AND trim(s) != ''
),
cand AS (
  SELECT c.id, lower(trim(s)) AS s
    FROM candidates c, jsonb_array_elements_text(c.skills) s
   WHERE c.data_env = 'prod'
     AND c.merged_into IS NULL
     AND c.duplicate_flag = false
     AND trim(s) != ''
),
hit AS (
  -- 現行条件でヒットする (必須スキル, 候補者側表記, 候補者)
  SELECT req.q, cand.s, cand.id
    FROM req JOIN cand
      ON cand.s LIKE '%' || req.q || '%' OR req.q LIKE '%' || cand.s || '%'
)
SELECT q                                   AS 必須スキル,
       s                                   AS 候補者側の表記,
       count(DISTINCT id)                  AS 人数,
       CASE WHEN s = q THEN '完全一致' ELSE '部分一致' END AS 種別
  FROM hit
 GROUP BY q, s
HAVING count(DISTINCT id) >= 3
 ORDER BY q, count(DISTINCT id) DESC;
