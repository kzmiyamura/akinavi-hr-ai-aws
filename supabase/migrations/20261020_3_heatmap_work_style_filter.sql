-- 人材マップに「リモート／常駐」の絞り込みを足す（2026-10-20 営業の要望
-- 「人材マップの絞り込みでリモート関連」）。
--
-- ■ 何で絞るか＝ raw_profile.workStyleTag（リモート希望 / 併用可 / 常駐可）
--   判定の正は inbound-email の deriveWorkStyleTag（本文のワークスタイル記載文から付ける）。
--   人材タブのカードに出ている Wifi 印と**同じ値・同じ言葉**なので、画面を跨いでも意味が変わらない。
--   ⚠ remoteAvailable（true/false）は使わない。あれは「リモート可と読めたか」の2値で、
--      常駐案件に出せるか（＝常駐可か併用可か）が分からない。タグが無く remoteAvailable だけ
--      ある人は本番で 152人(8%)。曖昧なまま通すより「未取得」として落とし、画面に書く。
--
-- ■ ボタンを決める前に数えた（prod 2026-10-20・1,913人／控え全期間 9,841人）
--   workStyleTag  併用可 472(25%) / 常駐可 378(20%) / リモート希望 222(12%) / 未取得 841(44%)
--   remoteAvailable（控え全期間） true 27% / false 21% / null 52%
--   リモートで出せる人（リモート希望＋併用可）694人・37県。常駐で出せる人（常駐可＋併用可）850人。
--   → 3つとも押して人が残るのでボタンにする。
--
-- ■ 未取得（44%）は絞ったら出ない
--   所属と同じ扱い（人材タブと同じ／その場で解除できる）。44%は多いので、
--   画面の注記に割合を必ず出す（黙って減らすと取りこぼしに見える）。
--
-- ■ アーカイブ済みは列が無いので、絞ったら除く（所属・稼働・経歴書と同じ）

DROP FUNCTION IF EXISTS public.prefecture_counts(text, text, text, text[], text[], boolean, boolean);
DROP FUNCTION IF EXISTS public.prefecture_counts(text, text, text, text[], text[], boolean, boolean, text[]);

CREATE FUNCTION public.prefecture_counts(
  p_data_env      text,
  p_skill         text    DEFAULT NULL,
  p_period        text    DEFAULT '7d',
  p_flows         text[]  DEFAULT NULL,   -- 商流（空＝指定なし）。中は OR
  p_types         text[]  DEFAULT NULL,   -- 雇用形態（空＝指定なし）。中は OR
  p_available_now boolean DEFAULT false,  -- 今日以前に稼働できると書かれている人だけ
  p_has_resume    boolean DEFAULT false,  -- 経歴書（resume/drive/box のいずれか）がある人だけ
  p_work_styles   text[]  DEFAULT NULL    -- workStyleTag（リモート希望/併用可/常駐可）。中は OR
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
      -- ワークスタイル。未取得は NULL = ANY(...) で落ちる（＝絞ったら出ない）
      AND (COALESCE(cardinality(p_work_styles), 0) = 0
           OR NULLIF(btrim(c.raw_profile->>'workStyleTag'), '') = ANY(p_work_styles))
  ),
  archived AS (
    SELECT a.id, normalize_prefecture(a.prefecture) AS prefecture
    FROM candidates_archive_light a
    WHERE p_period = 'all'
      AND COALESCE(cardinality(p_flows), 0) = 0
      AND COALESCE(cardinality(p_types), 0) = 0
      AND NOT COALESCE(p_available_now, false)
      AND NOT COALESCE(p_has_resume, false)
      AND COALESCE(cardinality(p_work_styles), 0) = 0
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

COMMENT ON FUNCTION public.prefecture_counts(text, text, text, text[], text[], boolean, boolean, text[]) IS
  '人材マップの県別人数。所属・すぐ稼働・経歴書あり・ワークスタイル（workStyleTag）で絞れる。'
  '未取得の人は絞ると出ない（人材タブと同じ）。絞るとアーカイブ済みは判定できないので除く';

DROP FUNCTION IF EXISTS public.candidates_by_prefecture(text, text, text, int, text, text, text[], text[], boolean, boolean);
DROP FUNCTION IF EXISTS public.candidates_by_prefecture(text, text, text, int, text, text, text[], text[], boolean, boolean, text[]);

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
  p_has_resume    boolean DEFAULT false,
  p_work_styles   text[]  DEFAULT NULL
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz,
              is_archived boolean, bookmarked boolean, desired_rate text,
              commercial_flow text, employment_type text,
              available_from text, experience_years int,
              work_style text)
LANGUAGE sql STABLE AS $$
  WITH hits AS (
    SELECT c.id, c.name, c.raw_profile->>'subject' AS subject, c.created_at,
           false AS is_archived, COALESCE(c.bookmarked, false) AS bookmarked,
           NULLIF(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text), '') AS desired_rate,
           NULLIF(btrim(c.raw_profile->>'commercialFlow'), '') AS commercial_flow,
           NULLIF(btrim(c.raw_profile->>'employmentType'), '') AS employment_type,
           NULLIF(btrim(c.raw_profile->>'availableFrom'), '') AS available_from,
           parse_available_from(c.raw_profile->>'availableFrom') AS available_date,
           c.experience_years,
           NULLIF(btrim(c.raw_profile->>'workStyleTag'), '') AS work_style
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
      AND (COALESCE(cardinality(p_work_styles), 0) = 0
           OR NULLIF(btrim(c.raw_profile->>'workStyleTag'), '') = ANY(p_work_styles))

    UNION

    SELECT a.id, a.name, a.subject, a.created_at,
           true AS is_archived, false AS bookmarked, NULL::text AS desired_rate,
           NULL::text AS commercial_flow, NULL::text AS employment_type,
           NULL::text AS available_from, NULL::date AS available_date,
           NULL::int AS experience_years, NULL::text AS work_style
    FROM candidates_archive_light a
    WHERE p_period = 'all'
      AND COALESCE(cardinality(p_flows), 0) = 0
      AND COALESCE(cardinality(p_types), 0) = 0
      AND NOT COALESCE(p_available_now, false)
      AND NOT COALESCE(p_has_resume, false)
      AND COALESCE(cardinality(p_work_styles), 0) = 0
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
         h.commercial_flow, h.employment_type, h.available_from, h.experience_years, h.work_style
  FROM hits h
  ORDER BY
    CASE WHEN p_sort = 'rate_low'   THEN parse_rate_man(h.desired_rate) END ASC  NULLS LAST,
    CASE WHEN p_sort = 'rate_high'  THEN parse_rate_man(h.desired_rate) END DESC NULLS LAST,
    CASE WHEN p_sort = 'avail_soon' THEN h.available_date END ASC  NULLS LAST,
    CASE WHEN p_sort = 'exp_high'   THEN h.experience_years END DESC NULLS LAST,
    CASE WHEN p_sort = 'old'        THEN h.created_at END ASC,
    h.created_at DESC, h.id
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.candidates_by_prefecture(text, text, text, int, text, text, text[], text[], boolean, boolean, text[]) IS
  '人材マップの県別一覧。p_sort: new（既定）/ old / rate_low / rate_high / avail_soon / exp_high。'
  '並びは必ずDB側で行う（返すのは先頭p_limit件なので、画面で並べ替えると母集団が変わる）。'
  '絞り込み（p_flows/p_types/p_available_now/p_has_resume/p_work_styles）が入るとアーカイブ済みは除く';

-- 確認（最後の文の結果だけ返る）
SELECT '絞り込みなし' AS 条件, sum(cnt) AS 人数, count(*) AS 県数
  FROM prefecture_counts('prod', NULL, '7d')
UNION ALL
SELECT 'リモート希望＋併用可', sum(cnt), count(*)
  FROM prefecture_counts('prod', NULL, '7d', NULL, NULL, false, false, ARRAY['リモート希望', '併用可'])
UNION ALL
SELECT '常駐可＋併用可', sum(cnt), count(*)
  FROM prefecture_counts('prod', NULL, '7d', NULL, NULL, false, false, ARRAY['常駐可', '併用可'])
UNION ALL
SELECT 'リモート希望のみ', sum(cnt), count(*)
  FROM prefecture_counts('prod', NULL, '7d', NULL, NULL, false, false, ARRAY['リモート希望']);
