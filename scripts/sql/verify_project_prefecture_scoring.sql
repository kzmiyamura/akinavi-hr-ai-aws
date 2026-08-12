-- work_prefecture を渡すと勤務地スコアが機能するかの検証（2026-08-12）
--
-- 対象は work_location に都道府県が書かれていない案件
-- （「東品川（最寄りは青物横丁または品川シーサイド）」）。
-- 従来は都道府県が切り出せず勤務地の重み20が全候補者で横並びになっていた。
-- ②で上位が東京都の候補者に寄れば期待どおり。
--
-- 実行: npx supabase db query --linked -f scripts/sql/verify_project_prefecture_scoring.sql

WITH p AS (
  SELECT * FROM projects WHERE work_location LIKE '東品川%' LIMIT 1
),
old AS (
  SELECT row_number() OVER () AS rank, c.name, c.raw_profile->>'prefecture' AS pref
  FROM p, LATERAL fetch_candidates_for_project(
    'prod', ARRAY(SELECT jsonb_array_elements_text(p.required_skills)),
    p.budget_min, p.budget_max, p.work_location, p.remote_policy,
    8, 40, 15, 15, 20, 10, false, NULL, NULL) c
),
new AS (
  SELECT row_number() OVER () AS rank, c.name, c.raw_profile->>'prefecture' AS pref
  FROM p, LATERAL fetch_candidates_for_project(
    'prod', ARRAY(SELECT jsonb_array_elements_text(p.required_skills)),
    p.budget_min, p.budget_max, p.work_location, p.remote_policy,
    8, 40, 15, 15, 20, 10, false, p.work_prefecture, p.required_experience_years) c
)
SELECT
  old.rank,
  old.name AS 従来_名前, old.pref AS 従来_県,
  new.name AS 新_名前,   new.pref AS 新_県,
  CASE WHEN old.name IS DISTINCT FROM new.name THEN '変化' ELSE '' END AS diff
FROM old FULL JOIN new ON old.rank = new.rank
ORDER BY COALESCE(old.rank, new.rank);
