-- ヒートマップのスキルフィルターを candidate_skills テーブルだけでなく
-- candidates.skills JSONB カラムも参照するよう修正
-- （upsertCandidate 経由で登録された候補者は candidate_skills を持たないため）

CREATE OR REPLACE FUNCTION public.prefecture_counts(
  p_data_env text,
  p_skill     text DEFAULT NULL,
  p_period    text DEFAULT '7d'
)
RETURNS TABLE(prefecture text, cnt bigint)
LANGUAGE sql STABLE AS $$
  WITH live AS (
    SELECT DISTINCT c.id,
           normalize_prefecture(c.raw_profile->>'prefecture') AS prefecture
    FROM candidates c
    WHERE c.data_env = p_data_env
      AND normalize_prefecture(c.raw_profile->>'prefecture') IS NOT NULL
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM candidate_skills cs
          WHERE cs.candidate_id = c.id AND cs.skill ILIKE '%' || p_skill || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.skills) s
          WHERE s ILIKE '%' || p_skill || '%'
        )
      )
  ),
  archived AS (
    SELECT DISTINCT a.id,
           normalize_prefecture(a.prefecture) AS prefecture
    FROM candidates_archive_light a
    LEFT JOIN LATERAL jsonb_array_elements_text(a.skills) sk ON p_skill IS NOT NULL
    WHERE p_period = 'all'
      AND a.data_env = p_data_env
      AND normalize_prefecture(a.prefecture) IS NOT NULL
      AND (p_skill IS NULL OR sk ILIKE '%' || p_skill || '%')
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

CREATE OR REPLACE FUNCTION public.candidates_by_prefecture(
  p_data_env  text,
  p_prefecture text,
  p_skill     text    DEFAULT NULL,
  p_limit     integer DEFAULT 10,
  p_period    text    DEFAULT '7d'
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz, is_archived boolean)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT
    c.id, c.name,
    c.raw_profile->>'subject' AS subject,
    c.created_at,
    false AS is_archived
  FROM candidates c
  WHERE c.data_env = p_data_env
    AND normalize_prefecture(c.raw_profile->>'prefecture') = p_prefecture
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
    AND (
      p_skill IS NULL
      OR EXISTS (
        SELECT 1 FROM candidate_skills cs
        WHERE cs.candidate_id = c.id AND cs.skill ILIKE '%' || p_skill || '%'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(c.skills) s
        WHERE s ILIKE '%' || p_skill || '%'
      )
    )

  UNION

  SELECT DISTINCT
    a.id, a.name, a.subject, a.created_at, true AS is_archived
  FROM candidates_archive_light a
  LEFT JOIN LATERAL jsonb_array_elements_text(a.skills) sk ON p_skill IS NOT NULL
  WHERE p_period = 'all'
    AND a.data_env = p_data_env
    AND normalize_prefecture(a.prefecture) = p_prefecture
    AND (p_skill IS NULL OR sk ILIKE '%' || p_skill || '%')

  ORDER BY created_at DESC
  LIMIT p_limit;
$$;
