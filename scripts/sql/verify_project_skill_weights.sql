-- 必須スキルの重み付けが効くかの検証（2026-08-12）
--
-- 対象は化成品メーカーのJava案件（必須: Java×6 / Spring Boot×3 / 保守開発×2 / テスト×1 / 基本設計×1）。
-- 従来は全スキル等価だったため「基本設計・テスト・保守開発」だけ持つ候補者が
-- Java を持つ候補者と同程度に上がる。上位N件の Java 保有率が上がれば期待どおり。
--
-- 実行: npx supabase db query --linked -f scripts/sql/verify_project_skill_weights.sql

WITH p AS (
  SELECT * FROM projects
   WHERE title LIKE '%精密機器%'
   LIMIT 1
),
old AS (
  SELECT row_number() OVER () AS rank, c.skills
  FROM p, LATERAL fetch_candidates_for_project(
    'prod', ARRAY(SELECT jsonb_array_elements_text(p.required_skills)),
    p.budget_min, p.budget_max, p.work_location, p.remote_policy,
    50, 40, 15, 15, 20, 10, false, p.work_prefecture, p.required_experience_years, NULL) c
),
new AS (
  SELECT row_number() OVER () AS rank, c.skills
  FROM p, LATERAL fetch_candidates_for_project(
    'prod', ARRAY(SELECT jsonb_array_elements_text(p.required_skills)),
    p.budget_min, p.budget_max, p.work_location, p.remote_policy,
    50, 40, 15, 15, 20, 10, false, p.work_prefecture, p.required_experience_years, p.skill_weights) c
),
hasjava AS (
  SELECT '① 従来（全スキル等価）' AS mode, rank,
         (SELECT count(*) > 0 FROM jsonb_array_elements_text(old.skills) s WHERE lower(s) LIKE '%vb.net%' OR lower(s) LIKE '%c#%') AS java
    FROM old
  UNION ALL
  SELECT '② 重み付きスコア', rank,
         (SELECT count(*) > 0 FROM jsonb_array_elements_text(new.skills) s WHERE lower(s) LIKE '%vb.net%' OR lower(s) LIKE '%c#%')
    FROM new
)
-- 言語（VB.net/C#）を持たない候補者の平均順位。重みが効けば順位は下がる（数字が大きくなる）
SELECT mode,
       count(*) FILTER (WHERE NOT java) AS 言語なし人数,
       round(avg(rank) FILTER (WHERE NOT java), 1) AS 言語なしの平均順位,
       round(avg(rank) FILTER (WHERE java), 1)     AS 言語ありの平均順位
  FROM hasjava
 GROUP BY mode
 ORDER BY mode;
