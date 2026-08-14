-- マッチング画面（人材モード）の左ペインをサーバー検索＋ページングにする。
--
-- 問題（2026-08-14 実測）:
--   人材モードを開くたびに fetch_candidates_for_matching で全 1,521 件（5.25MB）を引き、
--   検索はクライアント側で回していた。表示は50件ずつなのに毎回全件転送している。
--   egress は Free Plan 5GB に対し 2.98GB 消費済みで、その94%が PostgREST。
--
-- 対策: 絞り込みとページングを SQL 側でやる。
--
-- ⚠ 既存の search_candidates とは**別物**。あちらは duplicate_flag を除外しないので
--    マッチング画面に流用すると重複人材が一覧に出てしまう。
--    ここでは fetch_candidates_for_matching と**同一の絞り込み条件**を使う:
--      data_env / merged_into IS NULL / duplicate_flag = false
--    並び順も同じ（created_at DESC, experience_years DESC, id）。
--
-- 検索対象は左ペインの表示項目に合わせて name / email / skills の3つだけ。
-- 本文全文（raw_profile.text）は対象にしない——人材タブの全文検索は
-- 既存の search_candidates(p_scope='body') が担当しており、役割を分ける。

CREATE OR REPLACE FUNCTION search_candidates_for_matching(
  p_data_env text,
  p_keywords text[] DEFAULT NULL,
  p_mode     text    DEFAULT 'AND',
  p_limit    int     DEFAULT 50,
  p_offset   int     DEFAULT 0
)
RETURNS SETOF candidates_lite
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT *
  FROM candidates_lite c
  WHERE c.data_env       = p_data_env
    AND c.merged_into    IS NULL
    AND c.duplicate_flag = false
    AND (
      p_keywords IS NULL
      OR cardinality(p_keywords) = 0
      OR (
        CASE WHEN upper(p_mode) = 'OR'
          THEN EXISTS (
            SELECT 1 FROM unnest(p_keywords) kw
            WHERE c.name ILIKE '%' || kw || '%'
               OR COALESCE(c.email, '') ILIKE '%' || kw || '%'
               OR c.skills::text ILIKE '%' || kw || '%'
          )
          ELSE NOT EXISTS (
            SELECT 1 FROM unnest(p_keywords) kw
            WHERE NOT (
              c.name ILIKE '%' || kw || '%'
              OR COALESCE(c.email, '') ILIKE '%' || kw || '%'
              OR c.skills::text ILIKE '%' || kw || '%'
            )
          )
        END
      )
    )
  ORDER BY
    c.created_at DESC,
    COALESCE(c.experience_years, 0) DESC,
    c.id
  LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION search_candidates_for_matching(text, text[], text, int, int)
  TO anon, authenticated;

-- 該当件数だけを返す（本体を転送せずに「全N件」を出すため）
CREATE OR REPLACE FUNCTION count_candidates_for_matching(
  p_data_env text,
  p_keywords text[] DEFAULT NULL,
  p_mode     text    DEFAULT 'AND'
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT count(*)
  FROM candidates_lite c
  WHERE c.data_env       = p_data_env
    AND c.merged_into    IS NULL
    AND c.duplicate_flag = false
    AND (
      p_keywords IS NULL
      OR cardinality(p_keywords) = 0
      OR (
        CASE WHEN upper(p_mode) = 'OR'
          THEN EXISTS (
            SELECT 1 FROM unnest(p_keywords) kw
            WHERE c.name ILIKE '%' || kw || '%'
               OR COALESCE(c.email, '') ILIKE '%' || kw || '%'
               OR c.skills::text ILIKE '%' || kw || '%'
          )
          ELSE NOT EXISTS (
            SELECT 1 FROM unnest(p_keywords) kw
            WHERE NOT (
              c.name ILIKE '%' || kw || '%'
              OR COALESCE(c.email, '') ILIKE '%' || kw || '%'
              OR c.skills::text ILIKE '%' || kw || '%'
            )
          )
        END
      )
    );
$$;

GRANT EXECUTE ON FUNCTION count_candidates_for_matching(text, text[], text)
  TO anon, authenticated;
