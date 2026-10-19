-- 上位候補の印を「1時間ごとの計算し直し」から「人材が届いたときだけ」に変える。
--
-- 2026-10-20 営業の指示:
--   「1時間でやり直しとかしなくてもいい。人材が届いた際の判断のみで。」
--
-- ■ なぜ全体を計算し直す作りのままなのか（1人ぶんだけ計算しない理由）
--   順位は fetch_candidates_for_project（マッチング画面と同じ関数）を呼んで決めている。
--   この関数は「案件の上位N人」しか返さず、**1人のスコアだけを返す入口が無い**。
--   1人ぶんを判定するには案件の5位のスコアが要り、それを持つには結局1周する。
--   そして1周の値段は人数に関係なく一定（本番実測 open案件15件で30〜40秒）なので、
--   **届いた人をまとめて1回まわすのが一番安い**。
--   配点を別の場所に書き写せば1人ぶんの計算はできるが、それはマッチング画面と
--   印が食い違う作り（配点の2重定義）になるのでやらない。
--
-- ■ 届いた量（2026-10-20 実測・本番）
--   10/13 138人 / 10/14 203 / 10/15 222 / 10/16 248 / 10/17 3 / 10/18 0 / 10/19 942
--   1人届くたびに1周すると 942×35秒＝9時間。**到着ごとは不可能**。
--   そこで「10分おきに、前回の計算より後に届いた人がいるかだけ見る」。
--   いなければ何もしない（10/18 のような日は1度も計算しない）。
--   いれば1周する。印が付くまでの遅れは最大1時間から**最大10分**になる。
--
-- ■ 印に根拠を持たせる（必須9件中6件）
--   営業の疑い「本当か？データ分析基盤やで。bigqueryとかやろ？合ってるか？」に、
--   画面で答えられるようにする。1位の人は実際に BigQuery/S3/Glue/Python/SQL を
--   持っていたが、**画面からは確かめられなかった**。
--   充足数は skill_hit_weights（マッチングが使う判定の実体）に重み無しで数えさせる。
--   本番実測で 75行ぶん 4.6秒。1周 30〜40秒に対して許容できる。

ALTER TABLE public.top_match_marks
  ADD COLUMN IF NOT EXISTS skill_hit   integer,
  ADD COLUMN IF NOT EXISTS skill_total integer;

COMMENT ON COLUMN public.top_match_marks.skill_hit IS
  '案件の必須スキルのうち満たしている数。判定は skill_hit_weights（重み無し＝1件1点）';
COMMENT ON COLUMN public.top_match_marks.skill_total IS
  '案件の必須スキルの数。0 のときは「スキル指定の無い案件」なので画面には出さない';

-- ── 計算本体（充足数の記録を足した）────────────────────────────────────────────
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
        p_required_role => p.raw_data->'aiInterpretation'->>'requiredRole'
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

-- ── 到着があったときだけ計算する入口 ──────────────────────────────────────────
--
-- 戻り値: 入れた印の数 / -1 = 新しい人材も案件の変更も無かったので何もしていない
--
-- ⚠ candidates は created_at だけを見る。updated_at は常駐AI（pm2 akinavi-shadow）の
--   校正でも動くので、それを引き金にすると人が届いていなくても回り続ける。
--   同じ人の再送（UPDATE）で印が変わることはあるが、その人は次の新着と一緒に拾われる。
-- ⚠ 24時間以上まわっていなければ、到着が無くても1度まわす。
--   人材は7日で消え、消えた印は CASCADE で道連れになるため、静かな日が続くと
--   印の数だけが痩せていく。それを放置しないための下限。
CREATE OR REPLACE FUNCTION public.refresh_top_match_marks_if_new(p_data_env text DEFAULT 'prod')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last    timestamptz;
  v_arrived boolean;
  v_project boolean;
BEGIN
  SELECT NULLIF(trim(both '"' from value::text), '')::timestamptz
    INTO v_last FROM app_config WHERE key = 'top_match_marks_computed_at';

  -- 一度も計算していない / 24時間以上まわっていない場合は無条件でまわす
  IF v_last IS NULL OR v_last < now() - interval '24 hours' THEN
    RETURN refresh_top_match_marks(p_data_env);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM candidates
     WHERE data_env = p_data_env AND created_at > v_last
     LIMIT 1
  ) INTO v_arrived;

  SELECT EXISTS (
    SELECT 1 FROM projects
     WHERE data_env = p_data_env AND status = 'open' AND updated_at > v_last
     LIMIT 1
  ) INTO v_project;

  IF NOT v_arrived AND NOT v_project THEN
    RETURN -1;
  END IF;

  RETURN refresh_top_match_marks(p_data_env);
END
$$;

-- ── cron の入れ替え ───────────────────────────────────────────────────────────
-- 毎時固定（top-match-marks-hourly）をやめ、10分おきに「届いたか」だけを見る。
-- 届いていなければ EXISTS 2本で終わる＝実質ゼロコスト。
SELECT cron.unschedule('top-match-marks-hourly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'top-match-marks-hourly');

SELECT cron.unschedule('top-match-marks-on-arrival')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'top-match-marks-on-arrival');

SELECT cron.schedule('top-match-marks-on-arrival', '*/10 * * * *',
  $cmd$ SELECT public.refresh_top_match_marks_if_new('prod'); $cmd$);
