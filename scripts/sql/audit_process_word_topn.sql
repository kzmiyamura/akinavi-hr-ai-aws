-- 工程語（基本設計・テスト 等）だけで候補に残った人が、実際に営業の目に入る上位に
-- 何人いるかを測る（2026-08-13）。
--
-- 候補全体で 43%（化成品案件）が工程語だけで残っていても、順位が下位なら実害は小さい。
-- 高速モードは上位 BATCH_TOP_N 件しか AI 採点しないため、**上位に何人いるか**が本題。
--
-- 実際の案件パラメータ（重み・勤務地・単価・契約形態）をそのまま渡して順位を再現する。

CREATE OR REPLACE FUNCTION pg_temp.proc_word_topn(p_title_prefix text, p_top int)
RETURNS TABLE(案件 text, 上位n件 int, うち工程語だけ int, 割合_pct numeric)
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_proc text[] := ARRAY['基本設計','詳細設計','要件定義','テスト','単体テスト','結合テスト',
                         '総合テスト','運用保守','保守開発','設計','製造','実装','uat'];
BEGIN
  FOR r IN
    SELECT id, title,
           ARRAY(SELECT jsonb_array_elements_text(required_skills)) AS req,
           skill_weights, work_location, work_prefecture, remote_policy,
           budget_min, budget_max, required_experience_years, contract_type
      FROM projects
     WHERE data_env = 'prod' AND status = 'open'
       AND title LIKE p_title_prefix || '%'
       AND jsonb_array_length(COALESCE(required_skills, '[]'::jsonb)) > 0
  LOOP
    RETURN QUERY
    WITH tech AS (
      -- 技術スキル（工程語を除いた必須スキル）を1つ以上満たす人
      SELECT candidate_id
        FROM skill_hit_weights('prod',
               ARRAY(SELECT s FROM unnest(r.req) s WHERE NOT (lower(s) = ANY(v_proc))), NULL)
    ),
    top AS (
      SELECT c.id
        FROM fetch_candidates_for_project(
               'prod'::text, r.req, r.budget_min::numeric, r.budget_max::numeric,
               r.work_location, r.remote_policy, p_top,
               40, 15, 15, 20, 10, false, r.contract_type, r.work_prefecture,
               r.required_experience_years, r.skill_weights, NULL::text[]) c
    )
    SELECT r.title, p_top,
           (SELECT COUNT(*)::int FROM top WHERE top.id NOT IN (SELECT candidate_id FROM tech)),
           ROUND(100.0 * (SELECT COUNT(*) FROM top WHERE top.id NOT IN (SELECT candidate_id FROM tech))
                 / NULLIF((SELECT COUNT(*) FROM top), 0));
  END LOOP;
END $$;

SELECT * FROM pg_temp.proc_word_topn('１．化成品', 20)
UNION ALL
SELECT * FROM pg_temp.proc_word_topn('１．PowerShell', 20)
UNION ALL
SELECT * FROM pg_temp.proc_word_topn('１．精密機器', 20);
