-- 汎用スキル（誰でも持っていて選別に使えない必須スキル）が案件ごとにどれだけ効いているかを測る。
--
-- 背景（2026-08-13）:
--   必須スキルに「基本設計」「テスト」のような、全人材の4割超が持つ項目が入っていると、
--   技術要件を1つも満たさない人が候補に残る。実測では PowerShell 案件の上位20人中4人が
--   PowerShell も Azure Functions も持たず「基本設計」だけで上位にいた。
--
-- 判定の定義はコードと共有する（selective_skills / skill_master.is_generic）。
-- ここで語のリストをハードコードすると、また実装と食い違う。
--
-- 「汎用だけで残る人数」は、この絞り込みを入れる前なら候補に混ざっていた人数。
-- 現在の fetch_candidates_for_project はこの人たちを候補にしない。

WITH p AS (
  SELECT id, title,
         ARRAY(SELECT jsonb_array_elements_text(required_skills)) AS req
    FROM projects
   WHERE data_env = 'prod' AND status = 'open'
     AND jsonb_array_length(COALESCE(required_skills, '[]'::jsonb)) > 0
),
m AS (
  SELECT
    p.title,
    array_length(p.req, 1)                                              AS 必須スキル数,
    array_length(p.req, 1) - COALESCE(array_length(selective_skills(p.req), 1), 0)
                                                                        AS うち汎用,
    ARRAY(SELECT s FROM unnest(p.req) s
           WHERE NOT (s = ANY(selective_skills(p.req))))                AS 汎用スキル,
    (SELECT COUNT(*) FROM skill_hit_weights('prod', p.req, NULL))                    AS 旧_候補人数,
    (SELECT COUNT(*) FROM skill_hit_weights('prod', selective_skills(p.req), NULL))  AS 現_候補人数
  FROM p
)
SELECT
  title                          AS 案件,
  必須スキル数,
  うち汎用,
  array_to_string(汎用スキル, '/') AS 汎用と判定,
  旧_候補人数,
  現_候補人数,
  旧_候補人数 - 現_候補人数        AS 除外された人数,
  ROUND(100.0 * (旧_候補人数 - 現_候補人数) / NULLIF(旧_候補人数, 0)) AS 除外率_pct
FROM m
ORDER BY (旧_候補人数 - 現_候補人数) DESC;
