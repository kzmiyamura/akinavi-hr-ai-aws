-- fetch_candidates_for_project の実行時間を測る（statement_timeout 30秒に対する余裕の確認）
--
-- 実行: npx supabase db query --linked -f scripts/sql/bench_fetch_candidates.sql

WITH p AS (
  SELECT * FROM projects WHERE data_env = 'prod' ORDER BY created_at
),
t AS (
  SELECT p.id, left(p.title, 24) AS 案件,
         clock_timestamp() AS t0,
         (SELECT count(*) FROM fetch_candidates_for_project(
            'prod', ARRAY(SELECT jsonb_array_elements_text(p.required_skills)),
            p.budget_min, p.budget_max, p.work_location, p.remote_policy,
            500, 40, 15, 15, 20, 10, false,
            p.work_prefecture, p.required_experience_years, p.skill_weights)) AS 件数,
         clock_timestamp() AS t1
    FROM p
)
SELECT 案件, 件数,
       round(extract(milliseconds from (t1 - t0))::numeric
             + 1000 * extract(second from (t1 - t0))::numeric % 1000) AS 実行ms
  FROM t ORDER BY 3 DESC;
