-- 「マッチングをやり直したら上位に入るかも」の印（2026-10-19 営業の要望）。
--
-- ■ なぜ必要か
--   人材一覧にあった「マッチ済」は、**過去にマッチングを実行したときの上位**が
--   そのまま残っていただけで、今の順位とは関係が無かった。
--   実測（2026-10-19）: 上位20人しか保存しないはずの案件に 31件・28件 溜まっていた。
--   別の日に実行したときの上位20人が合算されるため。
--   人材は7日で消え毎日新しく入ってくるので、履歴は翌日にはもう当てにならない。
--
-- ■ 何を保存するか
--   公開中の案件それぞれについて、**今この瞬間の上位N人**。
--   順位の付け方はマッチング画面と同じ（fetch_candidates_for_project をそのまま呼ぶ。
--   配点の2重定義を作らない）。案件ごとのウェイト（raw_data.matchWeights）も反映する。
--
-- ■ なぜ表に溜めるのか（画面で都度計算しない）
--   本番実測で **open案件15件を1周するのに30〜40秒**。人材タブを開くたびには回せない。
--   1時間ごとに cron で計算して置いておく。印は最大1時間遅れる。
--
-- ■ 上位5人にした理由（2026-10-19 ユーザー判断）
--   本番 1,729人・open案件15件での実測:
--     上位3位まで  33人（1.9%）
--     上位5位まで  56人（3.2%）  ← これ
--     上位10位まで 101人（5.8%）
--     上位20位まで 189人（10.9%）
--   一覧をスクロールして目に留まる密度で、かつ「印が付いたら本当に刺さる」が保てる上限。
--   変えるときは top_match_rank_limit を書き換えて refresh を1回呼ぶ。

CREATE TABLE IF NOT EXISTS public.top_match_marks (
  data_env     text        NOT NULL,
  project_id   uuid        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  -- 人材が保持期間（7日）で消えたら印も道連れで消える。古い印が残らないのはこの CASCADE のおかげ
  candidate_id uuid        NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  rank         integer     NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, candidate_id)
);

COMMENT ON TABLE public.top_match_marks IS
  '公開中の案件ごとの「今の上位N人」。人材一覧の「上位候補」バッジの元。'
  '1時間ごとに refresh_top_match_marks() が入れ替える。人材・案件が消えれば CASCADE で消える。';

-- 人材一覧は「この人に印があるか」を人材IDの集合で引く
CREATE INDEX IF NOT EXISTS top_match_marks_candidate_idx
  ON public.top_match_marks (data_env, candidate_id);

ALTER TABLE public.top_match_marks ENABLE ROW LEVEL SECURITY;
-- 認証が無くフロントは anon で読む（他の表と同じ扱い）。書くのは SECURITY DEFINER の関数だけ
DROP POLICY IF EXISTS top_match_marks_read ON public.top_match_marks;
CREATE POLICY top_match_marks_read ON public.top_match_marks FOR SELECT USING (true);

-- 上位何人までを「上位候補」とするか。画面にもこの値を出すので app_config に置く
INSERT INTO app_config (key, value)
VALUES ('top_match_rank_limit', '5')
ON CONFLICT (key) DO NOTHING;

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
  -- app_config は jsonb。'5' も '"5"' も受けられるように trim('"') してから数値にする
  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::integer, 5)
    INTO v_limit FROM app_config WHERE key = 'top_match_rank_limit';
  v_limit := COALESCE(v_limit, 5);

  -- 入れ替えは1トランザクション。途中の状態が画面に見えないようにする
  DELETE FROM top_match_marks WHERE data_env = p_data_env;

  INSERT INTO top_match_marks (data_env, project_id, candidate_id, rank)
  SELECT p_data_env, t.project_id, t.candidate_id, t.rn
  FROM (
    SELECT p.id AS project_id, f.id AS candidate_id, f.rn
    FROM projects p
    CROSS JOIN LATERAL (
      SELECT c.id, row_number() OVER () AS rn
      FROM fetch_candidates_for_project(
        p_data_env           => p_data_env,
        p_required_skills    => ARRAY(SELECT jsonb_array_elements_text(
                                  COALESCE(p.required_skills, '[]'::jsonb))),
        p_budget_min         => p.budget_min,
        p_budget_max         => p.budget_max,
        p_work_location      => p.work_location,
        p_remote_policy      => p.remote_policy,
        p_limit              => v_limit,
        -- 案件ごとに保存したウェイトがあればそれを使う。画面と同じ順位にするため
        p_weight_skill       => COALESCE((p.raw_data->'matchWeights'->>'skill')::integer, 40),
        p_weight_exp         => COALESCE((p.raw_data->'matchWeights'->>'exp')::integer, 15),
        p_weight_rate        => COALESCE((p.raw_data->'matchWeights'->>'rate')::integer, 15),
        p_weight_location    => COALESCE((p.raw_data->'matchWeights'->>'location')::integer, 20),
        p_weight_remote      => COALESCE((p.raw_data->'matchWeights'->>'remote')::integer, 10),
        p_contract_type      => p.contract_type,
        p_work_prefecture    => p.work_prefecture,
        p_required_exp_years => p.required_experience_years,
        p_skill_weights      => p.skill_weights,
        p_nice_skills        => ARRAY(SELECT jsonb_array_elements_text(
                                  COALESCE(p.raw_data->'niceToHaveSkills', '[]'::jsonb))),
        p_required_role      => p.raw_data->'aiInterpretation'->>'requiredRole'
        -- p_require_haken は既定 false、p_location_gate は既定 true。
        -- 画面の既定と揃えている。派遣免許の絞りは画面で切り替える条件なので印には入れない
      ) c
    ) f
    WHERE p.data_env = p_data_env AND p.status = 'open'
  ) t;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO app_config (key, value)
  VALUES ('top_match_marks_computed_at', to_jsonb(now()::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION public.refresh_top_match_marks(text) IS
  '公開中の案件ごとの上位N人を計算し直して top_match_marks を入れ替える。'
  '本番実測で open案件15件・30〜40秒（2026-10-19）。戻り値は入れた行数。';

GRANT SELECT ON public.top_match_marks TO anon, authenticated;

-- 1時間ごと。通知（毎時0分）とずらして 20分に回す。
-- HTTP を挟まない純 SQL なので pg_net も Edge Function も要らない
SELECT cron.unschedule('top-match-marks-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'top-match-marks-hourly');

SELECT cron.schedule(
  'top-match-marks-hourly',
  '20 * * * *',
  $cmd$ SELECT public.refresh_top_match_marks('prod'); $cmd$
);
