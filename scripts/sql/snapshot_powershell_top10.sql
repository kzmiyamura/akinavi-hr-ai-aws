-- PowerShell案件（3d378a6f）の上位10名を、役割つきで出す。
-- 役割加点の前後で流して並びの変化を見る。返るのは10行だけなので egress は誤差。
--
-- 案件の requiredRole = クラウドエンジニア（実装系）なので、
-- 主役割が PMO / PM の人が沈み、実装系の人が上がるのが期待挙動。
WITH p AS (
  SELECT
    -- required_skills は jsonb なので text[] に直す（RPC の引数型に合わせる）
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(required_skills, '[]'::jsonb))) AS required_skills,
    budget_min::numeric AS budget_min, budget_max::numeric AS budget_max,
    work_location, work_prefecture,
    remote_policy, contract_type, required_experience_years, skill_weights,
    raw_data->'aiInterpretation'->>'requiredRole' AS required_role,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(raw_data->'niceToHaveSkills', '[]'::jsonb))) AS nice
  FROM projects WHERE id = '3d378a6f-b730-4091-ab57-a88621b4b0a0'
)
SELECT
  row_number() OVER () AS 順位,
  c.name,
  c.raw_profile->'roles'->>0 AS 主役割,
  (SELECT required_role FROM p) AS 案件の要求役割,
  role_affinity((SELECT required_role FROM p), c.raw_profile->'roles'->>0) AS 役割合致度
FROM p, LATERAL fetch_candidates_for_project(
  'prod', p.required_skills, p.budget_min, p.budget_max, p.work_location,
  p.remote_policy, 10, 40, 15, 15, 20, 10, false,
  p.contract_type, p.work_prefecture, p.required_experience_years, p.skill_weights, p.nice,
  -- 役割（2026-08-14 追加）。ここを渡さないと既定 NULL＝中立で加減点ゼロになる
  p.required_role, 20
) c;
