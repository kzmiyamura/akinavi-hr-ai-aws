-- 役割の重み（p_weight_role）を振って、上位10名の顔ぶれがどう変わるかを見る。
-- 「実装系が上位に何人入るか」「PMO/運用保守が何人残るか」だけを返すので
-- 転送量は数行ぶん（egress を使わない検証・CLAUDE.md 参照）。
WITH p AS (
  SELECT
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(required_skills, '[]'::jsonb))) AS required_skills,
    budget_min::numeric AS budget_min, budget_max::numeric AS budget_max,
    work_location, work_prefecture, remote_policy, contract_type,
    required_experience_years, skill_weights,
    raw_data->'aiInterpretation'->>'requiredRole' AS required_role,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(raw_data->'niceToHaveSkills', '[]'::jsonb))) AS nice
  FROM projects WHERE id = '3d378a6f-b730-4091-ab57-a88621b4b0a0'
),
w(weight) AS (VALUES (0), (20), (30), (40), (50)),
ranked AS (
  SELECT
    w.weight,
    row_number() OVER (PARTITION BY w.weight) AS rn,
    c.raw_profile->'roles'->>0 AS main_role,
    role_affinity((SELECT required_role FROM p), c.raw_profile->'roles'->>0) AS aff
  FROM w, p, LATERAL fetch_candidates_for_project(
    'prod', p.required_skills, p.budget_min, p.budget_max, p.work_location,
    p.remote_policy, 10, 40, 15, 15, 20, 10, false,
    p.contract_type, p.work_prefecture, p.required_experience_years, p.skill_weights, p.nice,
    p.required_role, w.weight
  ) c
)
SELECT
  weight                                             AS 重み,
  count(*) FILTER (WHERE aff >= 0.7)                 AS "実装系(上位10)",
  count(*) FILTER (WHERE aff <= 0.2)                 AS "畑違い(上位10)",
  min(rn)  FILTER (WHERE main_role = 'PMO')          AS "PMOの最高順位",
  (array_agg(main_role ORDER BY rn))[1]              AS "1位の役割"
FROM ranked
GROUP BY weight
ORDER BY weight;
