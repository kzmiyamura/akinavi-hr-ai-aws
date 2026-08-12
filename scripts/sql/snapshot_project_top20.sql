-- prod 案件ごとの上位20名スナップショット（スキル一致判定の変更前後を比べる用）
--
-- RPC は rule_score を返さないので、返却順＝順位として記録する。
-- 変更前に1回、変更後に1回実行して差分を目で比べる。
--
-- 実行: npx supabase db query --linked -f scripts/sql/snapshot_project_top20.sql

WITH p AS (
  SELECT id, title, required_skills, budget_min, budget_max, work_location,
         remote_policy, work_prefecture, required_experience_years, skill_weights
    FROM projects WHERE data_env = 'prod' ORDER BY created_at LIMIT 8
),
r AS (
  SELECT p.id AS pid, left(p.title, 20) AS 案件,
         row_number() OVER (PARTITION BY p.id) AS 順位,
         c.name, c.skills
    FROM p, LATERAL fetch_candidates_for_project(
      'prod', ARRAY(SELECT jsonb_array_elements_text(p.required_skills)),
      p.budget_min, p.budget_max, p.work_location, p.remote_policy,
      20, 40, 15, 15, 20, 10, false,
      p.work_prefecture, p.required_experience_years, p.skill_weights) c
)
SELECT 案件, 順位, left(name, 12) AS 氏名,
       -- 案件の必須スキルのうち、その人が「文字として」持っているもの
       (SELECT string_agg(DISTINCT s, ',')
          FROM jsonb_array_elements_text(r.skills) s
         WHERE lower(s) IN ('java','javascript','c','c#','sql','mysql','postgresql',
                            'shell','powershell','spring','spring boot','azure','azure functions'))
       AS 判定に効くスキル
  FROM r
 WHERE 順位 <= 20
 ORDER BY 案件, 順位;
