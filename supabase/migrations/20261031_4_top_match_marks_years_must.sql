-- 自動生成: scripts/gen_top_match_marks_years_must.py
-- 入力: supabase/migrations/20261020_top_match_marks_on_arrival.sql
--
-- 「上位候補」印の計算に、案件の年数指定を渡す（2026-10-31）。
-- fetch_candidates_for_project に年数の足切りが入った（20261031_3）ので、印も同じ候補から選ぶ。
-- 適用後に refresh_top_match_marks('prod') を1回呼ぶ。

CREATE OR REPLACE FUNCTION public.refresh_top_match_marks(p_data_env text DEFAULT 'prod')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_count integer;
BEGIN
  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::integer, 5)
    INTO v_limit FROM app_config WHERE key = 'top_match_rank_limit';
  v_limit := COALESCE(v_limit, 5);

  DELETE FROM top_match_marks WHERE data_env = p_data_env;

  INSERT INTO top_match_marks (data_env, project_id, candidate_id, rank)
  SELECT p_data_env, t.project_id, t.candidate_id, t.rn
  FROM (
    SELECT p.id AS project_id, f.id AS candidate_id, f.rn
    FROM projects p
    CROSS JOIN LATERAL (
      SELECT c.id, row_number() OVER () AS rn
      FROM fetch_candidates_for_project(
        p_data_env => p_data_env,
        p_required_skills => ARRAY(SELECT jsonb_array_elements_text(COALESCE(p.required_skills,'[]'::jsonb))),
        p_budget_min => p.budget_min, p_budget_max => p.budget_max,
        p_work_location => p.work_location, p_remote_policy => p.remote_policy,
        p_limit => v_limit,
        p_weight_skill    => COALESCE((p.raw_data->'matchWeights'->>'skill')::integer, 40),
        p_weight_exp      => COALESCE((p.raw_data->'matchWeights'->>'exp')::integer, 15),
        p_weight_rate     => COALESCE((p.raw_data->'matchWeights'->>'rate')::integer, 15),
        p_weight_location => COALESCE((p.raw_data->'matchWeights'->>'location')::integer, 20),
        p_weight_remote   => COALESCE((p.raw_data->'matchWeights'->>'remote')::integer, 10),
        p_contract_type => p.contract_type, p_work_prefecture => p.work_prefecture,
        p_required_exp_years => p.required_experience_years, p_skill_weights => p.skill_weights,
        p_nice_skills => ARRAY(SELECT jsonb_array_elements_text(COALESCE(p.raw_data->'niceToHaveSkills','[]'::jsonb))),
        p_required_role => p.raw_data->'aiInterpretation'->>'requiredRole',
        -- 案件が年数を書いた技術（2026-10-31「スキル年数はマスト」）。渡さないと印だけ足切りが効かない
        p_required_skill_years => p.raw_data->'requiredSkillYears'
      ) c
    ) f
    WHERE p.data_env = p_data_env AND p.status = 'open'
  ) t;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 必須スキルを何件満たしているか。マッチングと同じ判定（skill_hit_weights）に数えさせる。
  -- 重みを渡さないので1件1点＝件数になる
  WITH req AS (
    SELECT p.id AS project_id,
           ARRAY(SELECT jsonb_array_elements_text(COALESCE(p.required_skills,'[]'::jsonb))) AS skills
      FROM projects p
     WHERE p.data_env = p_data_env AND p.status = 'open'
  ),
  hits AS (
    SELECT r.project_id, h.candidate_id, h.hit_w
      FROM req r, LATERAL skill_hit_weights(p_data_env, r.skills, NULL) h
  ),
  calc AS (
    SELECT m.project_id, m.candidate_id,
           COALESCE(array_length(r.skills, 1), 0) AS total,
           COALESCE(h.hit_w, 0)::int             AS hit
      FROM top_match_marks m
      JOIN req r ON r.project_id = m.project_id
      LEFT JOIN hits h ON h.project_id = m.project_id AND h.candidate_id = m.candidate_id
     WHERE m.data_env = p_data_env
  )
  UPDATE top_match_marks m
     SET skill_hit = calc.hit, skill_total = calc.total
    FROM calc
   WHERE m.data_env = p_data_env
     AND m.project_id = calc.project_id
     AND m.candidate_id = calc.candidate_id;

  INSERT INTO app_config (key, value)
  VALUES ('top_match_marks_computed_at', to_jsonb(now()::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN v_count;
END
$$;
