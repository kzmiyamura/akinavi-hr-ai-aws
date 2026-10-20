-- 人材マップに「所属（商流×雇用形態）」「すぐ稼働できる」「経歴書あり」の絞り込みを足し、
-- 並び替えに「稼働が早い順」「経験年数が長い順」を足す（2026-10-20 営業の要望
-- 「人材マップ絞り込みに自社の社員とかも入れて」「使いやすさを考えて。人材マップ使う想定で
--  何が絞り込んでソート出来たら使いやすいか」）。
--
-- ■ ボタンを決める前に数えた（prod 実測 2026-10-20・1,878人／控え全期間 9,841人）
--
--   商流        自社 982(52%) / 1社先 553(29%) / **2社先以降 4人(0.2%)** / 未取得 339(18%)
--   雇用形態    正社員 669(36%) / フリーランス 638(34%) / 契約社員 133(7%)
--               / **派遣社員 14(0.7%)** / **業務委託 10(0.5%)** / 未取得 409(22%)
--   自社×正社員 359人（＝営業の言う「自社の社員」）
--   経歴書      あり 1,466(78%) / なし 412(22%)
--   稼働時期    記載あり 1,655(88%) / 日付として読める 1,541(82%)
--               うち今日以前（＝すぐ稼働可） **902人(48%)**
--   経験年数    あり 1,807(96%)
--
-- ■ 入れなかった選択肢と理由（押しても誰も出ないボタンを置かない）
--   `2社先以降`(4人) / `派遣社員`(14人) / `業務委託`(10人) は出さない。
--   県で割るとほぼ必ず0人になり、「絞り込みが壊れている」と読まれる。
--   人材マップのブックマーク（星）で同じ判断をしている（本番0人だったので並びに入れなかった・
--   20261020_heatmap_candidate_sort.sql）。**この RPC 自体は値を受け取れる**ので、
--   必要になったら画面側の選択肢に1行足すだけでよい（SQL は変更不要）。
--   派遣で出せるかは `filter_candidates` の `p_haken_ok`（派遣免許×正社員）が正。
--
-- ■ 未取得の人の扱い＝**絞ったら出ない**（人材タブと同じ）
--   商流18% / 雇用形態22% が未取得。人材タブの絞り込みも「商流・雇用形態は
--   読み取れない人を通さない（曖昧だと意味が無い）」としているので揃える。
--   `flow_bucket()` は未取得に NULL を返し、`NULL = ANY(...)` は NULL なので自然に落ちる。
--   ⚠ 通知ルール（notify-candidates）は逆で `include_unknown`（既定 true）に従う。
--      通知は「取りこぼしたら二度と届かない」ので通す、画面は「その場で解除できる」ので絞る。
--      画面には「未取得の人は出ません」と必ず書く（黙って消すと取りこぼしに見える）。
--
-- ■ 「すぐ稼働できる」は未記載を**通さない**
--   判定式は人材タブと同じ `parse_available_from(availableFrom) <= current_date`（即日=今日）。
--   ⚠ ただし NULL の扱いだけ逆。人材タブの「この日までに稼働できる人」は
--      読めない人を残す（母集団を削らないため）が、こちらはボタンの言葉が
--      「すぐ稼働できる」という**断定**なので、分からない人を混ぜると嘘になる。
--      違いが画面から読めるよう、ボタンの説明に「稼働時期が書かれている人だけ」と出す。
--
-- ■ アーカイブ済み（candidates_archive_light）は判定できないので除く
--   あの表は id/data_env/prefecture/skills/created_at/archived_at/name/subject しか持たない。
--   商流・雇用形態・経歴書・稼働時期・経験年数の列が無いので、全期間表示でこれらを絞ると
--   アーカイブ側は**一人も通せない**（通すと「自社正社員で絞ったのに所属不明の人が出る」）。
--   絞り込みが1つでも入ったらアーカイブ側を外し、画面にその注記を出す。
--
-- ■ 並び替えに足した2つ
--   `avail_soon`（稼働が早い順）… 営業が案件を受けて最初に確認する条件（CLAUDE.md §5）。
--                                 82%が日付として読めるので並びとして成立する。
--   `exp_high`（経験年数が長い順）… 96%取れている。ベテランから見たいとき用。
--   どちらも読めない人は NULLS LAST（アーカイブ済みも列が無いので後ろに固まる）。

-- ── 商流の丸め（1か所に置く）───────────────────────────────────────────────
-- ⚠ 文字列比較を画面と SQL の両方に書くとズレる。判定の正は
--    `supabase/functions/notify-candidates/match.ts` の flowBucket で、これはその SQL 版。
--    実データは `自社` と `N社先`（抽出側が `${normalizeShaNum(n)}社先` を作る）。
CREATE OR REPLACE FUNCTION public.flow_bucket(p_flow text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN COALESCE(btrim(p_flow), '') = '' THEN NULL      -- 未取得。= ANY(...) で落ちる
    WHEN btrim(p_flow) = '自社'  THEN '自社'
    WHEN btrim(p_flow) = '1社先' THEN '1社先'
    ELSE '2社先以降'                                      -- 2社先・3社先・想定外の表記
  END
$$;

COMMENT ON FUNCTION public.flow_bucket(text) IS
  '商流を 自社 / 1社先 / 2社先以降 に丸める（未取得は NULL）。'
  '正は notify-candidates/match.ts の flowBucket。人材マップの絞り込みで使う';

-- ── 県別の人数（地図の色・ランキング）─────────────────────────────────────
DROP FUNCTION IF EXISTS public.prefecture_counts(text, text, text);
DROP FUNCTION IF EXISTS public.prefecture_counts(text, text, text, text[], text[], boolean, boolean);

CREATE FUNCTION public.prefecture_counts(
  p_data_env      text,
  p_skill         text    DEFAULT NULL,
  p_period        text    DEFAULT '7d',
  p_flows         text[]  DEFAULT NULL,   -- 商流（空＝指定なし）。中は OR
  p_types         text[]  DEFAULT NULL,   -- 雇用形態（空＝指定なし）。中は OR
  p_available_now boolean DEFAULT false,  -- 今日以前に稼働できると書かれている人だけ
  p_has_resume    boolean DEFAULT false   -- 経歴書（resume/drive/box のいずれか）がある人だけ
)
RETURNS TABLE(prefecture text, cnt bigint)
LANGUAGE sql STABLE AS $$
  WITH live AS (
    SELECT c.id, normalize_prefecture(c.raw_profile->>'prefecture') AS prefecture
    FROM candidates c
    WHERE c.data_env = p_data_env
      AND c.merged_into IS NULL
      AND normalize_prefecture(c.raw_profile->>'prefecture') IS NOT NULL
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM candidate_skills cs
          WHERE cs.candidate_id = c.id
            AND cs.skill ILIKE '%' || p_skill || '%'          -- 速い前段
            AND skill_word_match(cs.skill, p_skill)            -- 語境界で確定
        )
      )
      -- 所属。未取得は flow_bucket が NULL を返すので通らない（＝絞ったら出ない）
      AND (COALESCE(cardinality(p_flows), 0) = 0
           OR flow_bucket(c.raw_profile->>'commercialFlow') = ANY(p_flows))
      AND (COALESCE(cardinality(p_types), 0) = 0
           OR NULLIF(btrim(c.raw_profile->>'employmentType'), '') = ANY(p_types))
      AND (NOT COALESCE(p_available_now, false)
           OR parse_available_from(c.raw_profile->>'availableFrom') <= current_date)
      AND (NOT COALESCE(p_has_resume, false)
           OR c.resume_url IS NOT NULL OR c.drive_url IS NOT NULL OR c.box_url IS NOT NULL)
  ),
  archived AS (
    SELECT a.id, normalize_prefecture(a.prefecture) AS prefecture
    FROM candidates_archive_light a
    WHERE p_period = 'all'
      -- 所属・稼働時期・経歴書の列を持たないので、1つでも絞られたら出せない
      AND COALESCE(cardinality(p_flows), 0) = 0
      AND COALESCE(cardinality(p_types), 0) = 0
      AND NOT COALESCE(p_available_now, false)
      AND NOT COALESCE(p_has_resume, false)
      AND a.data_env = p_data_env
      AND normalize_prefecture(a.prefecture) IS NOT NULL
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(a.skills) sk
          WHERE sk ILIKE '%' || p_skill || '%'
            AND skill_word_match(sk, p_skill)
        )
      )
  ),
  combined AS (
    SELECT id, prefecture FROM live
    UNION
    SELECT id, prefecture FROM archived
  )
  SELECT prefecture, COUNT(*)::bigint AS cnt
  FROM combined
  GROUP BY prefecture
  ORDER BY cnt DESC;
$$;

COMMENT ON FUNCTION public.prefecture_counts(text, text, text, text[], text[], boolean, boolean) IS
  '人材マップの県別人数。所属（商流×雇用形態）・すぐ稼働・経歴書ありで絞れる。'
  '未取得の人は絞ると出ない（人材タブと同じ）。絞ると アーカイブ済みは判定できないので除く';

-- ── 県を選んだときの一覧 ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.candidates_by_prefecture(text, text, text, int, text);
DROP FUNCTION IF EXISTS public.candidates_by_prefecture(text, text, text, int, text, text);
DROP FUNCTION IF EXISTS public.candidates_by_prefecture(text, text, text, int, text, text, text[], text[], boolean, boolean);

CREATE FUNCTION public.candidates_by_prefecture(
  p_data_env      text,
  p_prefecture    text,
  p_skill         text    DEFAULT NULL,
  p_limit         int     DEFAULT 10,
  p_period        text    DEFAULT '7d',
  p_sort          text    DEFAULT 'new',
  p_flows         text[]  DEFAULT NULL,
  p_types         text[]  DEFAULT NULL,
  p_available_now boolean DEFAULT false,
  p_has_resume    boolean DEFAULT false
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz,
              is_archived boolean, bookmarked boolean, desired_rate text,
              commercial_flow text, employment_type text,
              available_from text, experience_years int)
LANGUAGE sql STABLE AS $$
  WITH hits AS (
    SELECT c.id, c.name, c.raw_profile->>'subject' AS subject, c.created_at,
           false AS is_archived, COALESCE(c.bookmarked, false) AS bookmarked,
           -- fetch_candidates_for_project と同じ優先順（raw_profile が正・列は控え）
           NULLIF(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text), '') AS desired_rate,
           NULLIF(btrim(c.raw_profile->>'commercialFlow'), '') AS commercial_flow,
           NULLIF(btrim(c.raw_profile->>'employmentType'), '') AS employment_type,
           -- 画面には**書かれていた文字のまま**出す（単価と同じ。丸めた日付を出すと
           -- 「即日」が 10/20 に化けて、元メールと突き合わせたときに食い違う）
           NULLIF(btrim(c.raw_profile->>'availableFrom'), '') AS available_from,
           parse_available_from(c.raw_profile->>'availableFrom') AS available_date,
           c.experience_years
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
            AND cs.skill ILIKE '%' || p_skill || '%'
            AND skill_word_match(cs.skill, p_skill)
        )
      )
      AND (COALESCE(cardinality(p_flows), 0) = 0
           OR flow_bucket(c.raw_profile->>'commercialFlow') = ANY(p_flows))
      AND (COALESCE(cardinality(p_types), 0) = 0
           OR NULLIF(btrim(c.raw_profile->>'employmentType'), '') = ANY(p_types))
      AND (NOT COALESCE(p_available_now, false)
           OR parse_available_from(c.raw_profile->>'availableFrom') <= current_date)
      AND (NOT COALESCE(p_has_resume, false)
           OR c.resume_url IS NOT NULL OR c.drive_url IS NOT NULL OR c.box_url IS NOT NULL)

    UNION

    SELECT a.id, a.name, a.subject, a.created_at,
           true AS is_archived, false AS bookmarked, NULL::text AS desired_rate,
           NULL::text AS commercial_flow, NULL::text AS employment_type,
           NULL::text AS available_from, NULL::date AS available_date,
           NULL::int AS experience_years
    FROM candidates_archive_light a
    WHERE p_period = 'all'
      AND COALESCE(cardinality(p_flows), 0) = 0
      AND COALESCE(cardinality(p_types), 0) = 0
      AND NOT COALESCE(p_available_now, false)
      AND NOT COALESCE(p_has_resume, false)
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
  SELECT h.id, h.name, h.subject, h.created_at, h.is_archived, h.bookmarked, h.desired_rate,
         h.commercial_flow, h.employment_type, h.available_from, h.experience_years
  FROM hits h
  ORDER BY
    -- 知らない p_sort は全部の CASE が NULL になるので「新しい順」に落ちる（既定と同じ）
    CASE WHEN p_sort = 'rate_low'   THEN parse_rate_man(h.desired_rate) END ASC  NULLS LAST,
    CASE WHEN p_sort = 'rate_high'  THEN parse_rate_man(h.desired_rate) END DESC NULLS LAST,
    CASE WHEN p_sort = 'avail_soon' THEN h.available_date END ASC  NULLS LAST,
    CASE WHEN p_sort = 'exp_high'   THEN h.experience_years END DESC NULLS LAST,
    CASE WHEN p_sort = 'old'        THEN h.created_at END ASC,
    -- 同値のときは受信が新しい順 → id。同じ入力なら必ず同じ並びになる（揺れると上から潰せない）
    h.created_at DESC, h.id
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.candidates_by_prefecture(text, text, text, int, text, text, text[], text[], boolean, boolean) IS
  '人材マップの県別一覧。p_sort: new（既定）/ old / rate_low / rate_high / avail_soon / exp_high。'
  '並びは必ずDB側で行う（返すのは先頭p_limit件なので、画面で並べ替えると母集団が変わる）。'
  '絞り込み（p_flows/p_types/p_available_now/p_has_resume）が入るとアーカイブ済みは除く';

-- 確認（`supabase db query -f` は最後の文の結果だけを返す）
SELECT '絞り込みなし' AS 条件, sum(cnt) AS 人数, count(*) AS 県数
  FROM prefecture_counts('prod', NULL, '7d', NULL, NULL, false, false)
UNION ALL
SELECT '自社×正社員', sum(cnt), count(*)
  FROM prefecture_counts('prod', NULL, '7d', ARRAY['自社'], ARRAY['正社員'], false, false)
UNION ALL
SELECT 'すぐ稼働できる', sum(cnt), count(*)
  FROM prefecture_counts('prod', NULL, '7d', NULL, NULL, true, false)
UNION ALL
SELECT '経歴書あり', sum(cnt), count(*)
  FROM prefecture_counts('prod', NULL, '7d', NULL, NULL, false, true);
