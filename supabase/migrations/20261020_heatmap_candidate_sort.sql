-- 人材マップの都道府県一覧を並び替えられるようにする（2026-10-20 営業の要望
-- 「人材マップの表示されてる人材の並び替えも簡単にできると嬉しいな」）
--
-- ⚠ なぜ画面側（JS）で並べないのか。
--    この RPC は **新しい順の先頭 p_limit 件（既定10件）しか返さない**。
--    受け取った10件を画面で並べ替えると「古い順」は *新着10件を古い順に並べたもの*
--    になり、その県でいちばん古い人は1人も出ない。単価順も同じで、
--    「新着10件の中でいちばん安い人」しか見えない＝**何も測っていない並び**になる。
--    並びを変えると母集団が変わるので、ORDER BY は DB 側に置くほかない。
--    （会社管理の並び替え（agentCompanySort.ts）は一覧を全件持っているので画面側で並べている）
--
-- 単価の読み取りは人材タブの絞り込みと同じ parse_rate_man()（範囲は下限・20〜300万）。
-- ここで別の規則を書くと「人材タブの50万以上」と「マップの安い順」が食い違う。
-- 読めない人は NULLS LAST で最後に回す
-- （ローカル控え実測: 9,841人中 551人＝5.6% は単価が読めない）。
--
-- ⚠ 「星つきを先に」は入れなかった。本番実測（2026-10-20）で
--    **ブックマークが付いている人材は 0人**（1,822人中）。押しても並びが変わらない
--    ボタンは「効いていない」と思われるだけなので、星が使われ始めてから足す
--    （ORDER BY に `CASE WHEN p_sort='star' THEN (NOT bookmarked)::int END` を1行足すだけ）。
--
-- ⚠ アーカイブ済み（candidates_archive_light）は希望単価の列を持たない
--    （prefecture / skills / name / subject / created_at だけ）。
--    全期間表示で単価順にすると、アーカイブ済みは全員 NULL で後ろに固まる。
--    列を足すには archive-candidates の作り直しと再アーカイブが必要なので、
--    今は「直近7日なら効く並び」として入れる。画面にもその注記を出す。

DROP FUNCTION IF EXISTS candidates_by_prefecture(text, text, text, int, text);
DROP FUNCTION IF EXISTS candidates_by_prefecture(text, text, text, int, text, text);

CREATE FUNCTION public.candidates_by_prefecture(
  p_data_env   text,
  p_prefecture text,
  p_skill      text DEFAULT NULL,
  p_limit      int  DEFAULT 10,
  p_period     text DEFAULT '7d',
  p_sort       text DEFAULT 'new'
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz,
              is_archived boolean, bookmarked boolean, desired_rate text)
LANGUAGE sql STABLE AS $$
  WITH hits AS (
    SELECT c.id, c.name, c.raw_profile->>'subject' AS subject, c.created_at,
           false AS is_archived, COALESCE(c.bookmarked, false) AS bookmarked,
           -- fetch_candidates_for_project と同じ優先順（raw_profile が正・列は控え）
           NULLIF(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text), '') AS desired_rate
    FROM candidates c
    WHERE c.data_env = p_data_env
      AND normalize_prefecture(c.raw_profile->>'prefecture') = p_prefecture
      AND c.merged_into IS NULL
      AND c.duplicate_flag = false
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM candidate_skills cs
          WHERE cs.candidate_id = c.id
            AND cs.skill ILIKE '%' || p_skill || '%'          -- 速い前段
            AND skill_word_match(cs.skill, p_skill)            -- 語境界で確定
        )
      )

    UNION

    SELECT a.id, a.name, a.subject, a.created_at,
           true AS is_archived, false AS bookmarked, NULL::text AS desired_rate
    FROM candidates_archive_light a
    WHERE p_period = 'all'
      AND a.data_env = p_data_env
      AND normalize_prefecture(a.prefecture) = p_prefecture
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(a.skills) sk
          WHERE sk ILIKE '%' || p_skill || '%'
            AND skill_word_match(sk, p_skill)
        )
      )
  )
  SELECT h.id, h.name, h.subject, h.created_at, h.is_archived, h.bookmarked, h.desired_rate
  FROM hits h
  ORDER BY
    -- 知らない p_sort は全部の CASE が NULL になるので「新しい順」に落ちる（既定と同じ）
    CASE WHEN p_sort = 'rate_low'  THEN parse_rate_man(h.desired_rate) END ASC  NULLS LAST,
    CASE WHEN p_sort = 'rate_high' THEN parse_rate_man(h.desired_rate) END DESC NULLS LAST,
    CASE WHEN p_sort = 'old'       THEN h.created_at END ASC,
    -- 同値のときは受信が新しい順 → id。同じ入力なら必ず同じ並びになる（揺れると上から潰せない）
    h.created_at DESC, h.id
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.candidates_by_prefecture(text, text, text, int, text, text) IS
  '人材マップの県別一覧。p_sort: new（既定）/ old / rate_low / rate_high。'
  '並びは必ずDB側で行う（返すのは先頭p_limit件なので、画面で並べ替えると母集団が変わる）';
