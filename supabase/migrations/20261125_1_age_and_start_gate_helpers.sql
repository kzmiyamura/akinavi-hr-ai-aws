-- #192（2026-11-17 営業報告）マッチングの部品: 年齢の上限・稼働を案件の開始日で比べる
--
-- 報告: SMBC の COBOL 案件で、良いと思った WA（京王多摩センター）・YK（北松戸）が結果に入らない。
--       必須に「43歳以下」を入れたのに、上位が50〜60代になった。
--
-- 原因は2つ（控えと本番で実測）:
--  ① 「43歳以下」は required_skills に入るだけで、**スキルとして照合されていた**。
--     誰も持っていないので全員が同じだけ減点され、順位には何も効かない。
--     同じ書き方の案件がもう1件ある（「50歳未満」）。年齢は 1,754人中 1,677人（96%）で取れている
--  ② 「今出せる人だけ」が **稼働 ≦ 今日** で比べていた。この案件は 12/1 開始なのに、
--     「12月〜」稼働の WA さん（2件とも 1社先・経歴書あり）が「来月以降」で落ちていた。
--     開始日は公開中17件のうち13件で取れている（projects.start_date）
--
-- 方針:
--  ・必須欄の「NN歳以下 / 未満 / まで / 迄」「N0代まで」を年齢の上限として読む。
--    上限を超える人と、**年齢が取れていない人を外す**（居住地・スキル年数と同じマストの扱い）
--  ・稼働は max(今日, 案件の開始日) と比べる。開始日が無い・過去なら今まで通り今日
--  ・YK さんは経歴書が無い（本文だけ）ので、②を直しても「今出せる人だけ」では出ない。これは仕様

-- ── 必須欄から年齢の上限を読む（複数あれば厳しい方）。無ければ NULL ──
CREATE OR REPLACE FUNCTION public.required_age_max(p_required_skills text[])
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$
  SELECT min(v) FROM (
    SELECT CASE
             WHEN m1 IS NOT NULL THEN m1[1]::int - CASE WHEN m1[2] = '未満' THEN 1 ELSE 0 END
             WHEN m2 IS NOT NULL THEN m2[1]::int * 10 + 9
           END AS v
      FROM unnest(COALESCE(p_required_skills, ARRAY[]::text[])) x
      CROSS JOIN LATERAL (SELECT translate(trim(x), '０１２３４５６７８９　', '0123456789 ') AS t) n
      CROSS JOIN LATERAL (SELECT regexp_match(n.t, '^(\d{2})\s*歳\s*(以下|未満|まで|迄)$') AS m1,
                                 regexp_match(n.t, '^([1-9])0\s*代\s*(以下|まで|迄)$')       AS m2) r
  ) s
$$;
COMMENT ON FUNCTION public.required_age_max(text[]) IS
  '必須スキル欄の「43歳以下」「50歳未満」「40代まで」を年齢の上限として読む（#192・2026-11-25）。無ければ NULL';

-- ── 年齢の上限を満たすか。上限が無ければ全員通す。年齢が取れていない人は通さない ──
CREATE OR REPLACE FUNCTION public.age_gate_ok(p_age_max integer, p_age_raw text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_age_max IS NULL
      OR (COALESCE(p_age_raw, '') ~ '^\d{1,3}$' AND p_age_raw::int <= p_age_max)
$$;
COMMENT ON FUNCTION public.age_gate_ok(integer, text) IS
  '年齢のマスト（#192）。raw_profile.age が上限以下なら通す。未取得は外す（居住地・スキル年数と同じ扱い）';

-- ── 今出せる人: 稼働を「今日」ではなく max(今日, 案件の開始日) と比べる版 ──
-- current_date を読むので STABLE（旧版は IMMUTABLE だったが、日をまたいだ計画の使い回しで
-- 前日の日付のまま比べる余地がある）
CREATE OR REPLACE FUNCTION public.offerable_ok(
  p_gate        boolean,
  p_flow        text,
  p_has_resume  boolean,
  p_avail_date  date,
  p_by          date      -- 案件の開始日（projects.start_date）。NULL なら今日
)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NOT COALESCE(p_gate, true)
    OR (
      flow_bucket(p_flow) IN ('自社', '1社先')
      AND COALESCE(p_has_resume, false)
      AND p_avail_date IS NOT NULL
      AND p_avail_date <= GREATEST(current_date, COALESCE(p_by, current_date))
    ),
    false)
$$;
COMMENT ON FUNCTION public.offerable_ok(boolean, text, boolean, date, date) IS
  '今うちから出せる人か（自社or1社先 × 経歴書あり × 稼働が max(今日, 案件の開始日) 以前）。未取得は通さない。'
  '4引数版（人材マップ）は開始日なし＝今日で比べる。式はこちらに1つだけ置く（#192・2026-11-25）';

-- 4引数版（人材マップ・案件が無い画面）は5引数版に委ねる。式を2か所に持たない
CREATE OR REPLACE FUNCTION public.offerable_ok(
  p_gate        boolean,
  p_flow        text,
  p_has_resume  boolean,
  p_avail_date  date
)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT offerable_ok(p_gate, p_flow, p_has_resume, p_avail_date, NULL::date)
$$;

GRANT EXECUTE ON FUNCTION public.required_age_max(text[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.age_gate_ok(integer, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.offerable_ok(boolean, text, boolean, date, date) TO anon, authenticated, service_role;
