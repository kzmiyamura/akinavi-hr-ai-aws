-- 人材マップ表示速度改善 その2（Issue #118）
--
-- raw_profile は平均約9.7KB・最大137KBのJSONB（メール本文全文を含む）で、
-- prefecture_counts の集計時に全候補者分（3000件超）を毎回 TOAST 展開していたため
-- 2.5秒近くかかっていた。都道府県の正規化結果だけを軽量な生成列として切り出し、
-- 集計・絞り込みが raw_profile を一切デトースト（展開）せずに完結するようにする。

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS prefecture_norm text
  GENERATED ALWAYS AS (normalize_prefecture(raw_profile->>'prefecture')) STORED;

CREATE INDEX IF NOT EXISTS idx_candidates_prefecture_norm
  ON candidates (data_env, prefecture_norm)
  WHERE merged_into IS NULL AND prefecture_norm IS NOT NULL;

DROP INDEX IF EXISTS idx_candidates_norm_prefecture;

-- スキル絞り込み時の candidate_skills.skill ILIKE '%...%' が btree では使えず
-- 100万行超をSeq Scanしていたため trigram インデックスを追加（1120ms→45ms）
CREATE INDEX IF NOT EXISTS idx_candidate_skills_skill_trgm
  ON candidate_skills USING gin (skill gin_trgm_ops);

DROP FUNCTION IF EXISTS prefecture_counts(text, text, text);
CREATE OR REPLACE FUNCTION prefecture_counts(
  p_data_env text,
  p_skill    text    DEFAULT NULL,
  p_period   text    DEFAULT '7d'
)
RETURNS TABLE(prefecture text, cnt bigint)
LANGUAGE sql STABLE AS $$
  WITH live AS (
    SELECT c.id, c.prefecture_norm AS prefecture
    FROM candidates c
    WHERE c.data_env = p_data_env
      AND c.merged_into IS NULL
      AND c.prefecture_norm IS NOT NULL
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM candidate_skills cs
          WHERE cs.candidate_id = c.id AND cs.skill ILIKE '%' || p_skill || '%'
        )
      )
  ),
  archived AS (
    SELECT a.id, normalize_prefecture(a.prefecture) AS prefecture
    FROM candidates_archive_light a
    WHERE p_period = 'all'
      AND a.data_env = p_data_env
      AND normalize_prefecture(a.prefecture) IS NOT NULL
      AND (
        p_skill IS NULL
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(a.skills) sk
          WHERE sk ILIKE '%' || p_skill || '%'
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

DROP FUNCTION IF EXISTS candidates_by_prefecture(text, text, text, int, text);
CREATE OR REPLACE FUNCTION candidates_by_prefecture(
  p_data_env   text,
  p_prefecture text,
  p_skill      text DEFAULT NULL,
  p_limit      int  DEFAULT 10,
  p_period     text DEFAULT '7d'
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz, is_archived boolean)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.name, c.raw_profile->>'subject' AS subject, c.created_at, false AS is_archived
  FROM candidates c
  WHERE c.data_env = p_data_env
    AND c.prefecture_norm = p_prefecture
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
    AND (
      p_skill IS NULL
      OR EXISTS (
        SELECT 1 FROM candidate_skills cs
        WHERE cs.candidate_id = c.id AND cs.skill ILIKE '%' || p_skill || '%'
      )
    )

  UNION

  SELECT a.id, a.name, a.subject, a.created_at, true AS is_archived
  FROM candidates_archive_light a
  WHERE p_period = 'all'
    AND a.data_env = p_data_env
    AND normalize_prefecture(a.prefecture) = p_prefecture
    AND (
      p_skill IS NULL
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(a.skills) sk
        WHERE sk ILIKE '%' || p_skill || '%'
      )
    )

  ORDER BY created_at DESC
  LIMIT p_limit;
$$;
