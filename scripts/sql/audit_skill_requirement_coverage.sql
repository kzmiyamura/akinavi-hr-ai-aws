-- 必須スキルごとの充足人数を、旧ルール（部分一致）と現行ルールで比べる（2026-08-12）
--
-- 旧: lower(s) LIKE '%'||q||'%' OR q LIKE '%'||lower(s)||'%'
-- 現: skill_satisfies(s, q)  … 正規化＋包含関係＋語境界（20260812_skill_match_normalize.sql）
--
-- 必須スキルの配点は「満たした重みの合計 ÷ 全体の重み合計」なので、
-- ここの人数がそのままスコアの分子になる。マッチングの順位が変だと思ったらまずここを見る。
--
-- 実行: npx supabase db query --linked -f scripts/sql/audit_skill_requirement_coverage.sql

WITH map AS MATERIALIZED (SELECT k, canon FROM skill_norm_map),
req0 AS (
  SELECT DISTINCT lower(trim(s)) AS name, skill_key(s) AS qk
    FROM projects p, jsonb_array_elements_text(p.required_skills) s
   WHERE p.data_env = 'prod' AND trim(s) != ''
),
req AS (
  SELECT req0.name, COALESCE(m.canon, req0.qk) AS canon,
         '(^|[^a-z0-9#+])' ||
         regexp_replace(req0.name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') ||
         '([^a-z0-9#+]|$)' AS pat
    FROM req0 LEFT JOIN map m ON m.k = req0.qk
),
cs AS MATERIALIZED (
  SELECT c.id, lower(trim(s.value)) AS s, skill_key(s.value) AS sk
    FROM candidates c CROSS JOIN LATERAL jsonb_array_elements_text(c.skills) s(value)
   WHERE c.data_env = 'prod' AND c.merged_into IS NULL
     AND c.duplicate_flag = false AND trim(s.value) != ''
),
csc AS (
  SELECT cs.id, cs.s, COALESCE(m1.canon, m2.canon, cs.sk) AS s_canon
    FROM cs
    LEFT JOIN map m1 ON m1.k = cs.sk
    LEFT JOIN map m2 ON m1.canon IS NULL
                    AND cs.sk ~ '[0-9.]$'
                    AND length(regexp_replace(cs.sk, '[0-9.]+$', '')) >= 2
                    AND m2.k = regexp_replace(cs.sk, '[0-9.]+$', '')
),
pairs AS (
  SELECT r.name, csc.id,
         (csc.s LIKE '%' || r.name || '%' OR r.name LIKE '%' || csc.s || '%') AS 旧,
         (csc.s_canon = r.canon
          OR EXISTS (SELECT 1 FROM skill_implications i
                      WHERE i.child = csc.s_canon AND i.parent = r.canon)
          OR (csc.s LIKE '%' || r.name || '%' AND csc.s ~ r.pat))            AS 現
    FROM req r JOIN csc
      ON csc.s LIKE '%' || r.name || '%'
      OR r.name LIKE '%' || csc.s || '%'
      OR csc.s_canon = r.canon
      OR EXISTS (SELECT 1 FROM skill_implications i
                  WHERE i.child = csc.s_canon AND i.parent = r.canon)
)
SELECT name AS 必須スキル,
       count(DISTINCT id) FILTER (WHERE 旧) AS 旧ルール,
       count(DISTINCT id) FILTER (WHERE 現) AS 現行,
       count(DISTINCT id) FILTER (WHERE 現) - count(DISTINCT id) FILTER (WHERE 旧) AS 差
  FROM pairs
 GROUP BY name
 ORDER BY abs(count(DISTINCT id) FILTER (WHERE 現) - count(DISTINCT id) FILTER (WHERE 旧)) DESC;
