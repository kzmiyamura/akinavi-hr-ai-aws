-- 「今うちから出せる人だけ」の判定を1か所に置く（2026-10-20 営業の指示「ボタンをおけ」）
--
-- ■ なぜ要るか（本番実測 2026-10-20・公開15案件の上位5人＝75人）
--   すぐ稼働できる 24人(32%) / 来月以降 25 / 稼働時期が読めない 26
--   3つ全部OK（自社or1社先・経歴書・すぐ）は **20人(27%)**。
--   上位5人に出せる人が1人もいない案件が3件。
--   採点式（スキル・経験・単価・勤務地・リモート）にはこの3つが入っていないので、
--   重みをいくら動かしても「出せない人が上位」は消えない。人材マップで絞れる3条件と
--   同じものを、マッチングでは**前提条件**（勤務地の縛りと同じ形）にする。
--
-- ■ 判定（人材マップの絞りと同じ式）
--   ・所属   … flow_bucket が 自社 or 1社先（2社先以降・未取得は出さない）
--   ・経歴書 … resume_url / drive_url / box_url のいずれか
--   ・稼働   … parse_available_from(availableFrom) <= 今日（未記載・読めないは出さない）
--   ⚠ 「未取得は出さない」は人材マップと揃えた（曖昧な絞りは意味が無い／画面で切れる）。
--      通知ルールだけは逆（include_unknown）。理由は CLAUDE.md の人材マップの項。
--
-- ■ 呼ぶ側は条件を書かない
--   fetch_candidates_for_project（マッチング画面・top_match_marks・auto-match）が共有する
--   唯一の定義。location_gate_ok と同じ扱い（20261012_1_location_gate_shared.sql）。

CREATE OR REPLACE FUNCTION public.offerable_ok(
  p_gate        boolean,
  p_flow        text,     -- raw_profile.commercialFlow（丸める前）
  p_has_resume  boolean,
  p_avail_date  date      -- parse_available_from(raw_profile.availableFrom)
)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  -- ⚠ flow_bucket(NULL) IN (...) は NULL になり、関数全体が NULL を返す。
  --    WHERE では偽扱いで実害は無いが「false」と言い切れないので COALESCE で固める
  SELECT COALESCE(
    NOT COALESCE(p_gate, true)
    OR (
      flow_bucket(p_flow) IN ('自社', '1社先')
      AND COALESCE(p_has_resume, false)
      AND p_avail_date IS NOT NULL
      AND p_avail_date <= current_date
    ),
    false)
$$;

COMMENT ON FUNCTION public.offerable_ok(boolean, text, boolean, date) IS
  '今うちから出せる人か（自社or1社先 × 経歴書あり × 稼働が今日以前）。未取得は通さない。'
  'fetch_candidates_for_project の前提条件。人材マップの絞りと同じ式（2026-10-20）';

GRANT EXECUTE ON FUNCTION public.offerable_ok(boolean, text, boolean, date) TO anon, authenticated, service_role;

-- 確認（最後の文の結果だけ返る）
SELECT
  offerable_ok(true,  '自社',   true,  current_date)         AS "自社_経歴書_即日_true",
  offerable_ok(true,  '1社先',  true,  current_date - 3)     AS "1社先_過去日_true",
  offerable_ok(true,  '2社先',  true,  current_date)         AS "2社先_false",
  offerable_ok(true,  NULL,     true,  current_date)         AS "商流未取得_false",
  offerable_ok(true,  '自社',   false, current_date)         AS "経歴書なし_false",
  offerable_ok(true,  '自社',   true,  current_date + 20)    AS "来月_false",
  offerable_ok(true,  '自社',   true,  NULL)                 AS "稼働未記載_false",
  offerable_ok(false, '2社先',  false, NULL)                 AS "縛りなし_true",
  (SELECT count(*) FROM candidates c WHERE c.data_env = 'prod' AND c.merged_into IS NULL
     AND offerable_ok(true, c.raw_profile->>'commercialFlow',
                      c.resume_url IS NOT NULL OR c.drive_url IS NOT NULL OR c.box_url IS NOT NULL,
                      parse_available_from(c.raw_profile->>'availableFrom')))
    AS "本番で出せる人";
