-- 人材マップ（ヒートマップ）表示速度改善（Issue #118）
--
-- 問題:
-- 1. prefecture_counts / candidates_by_prefecture が、スキル未指定（p_skill IS NULL）
--    の場合でも candidate_skills を LEFT JOIN しており、3640候補者×平均27.6スキル
--    ≒10万行にまで膨らんだ結果を DISTINCT で畳んでいた（無駄な結合）
-- 2. normalize_prefecture(raw_profile->>'prefecture') に対応するインデックスが無く、
--    WHERE句評価のたびに全件シーケンシャルスキャン + 関数呼び出しが発生していた
--
-- 対応:
-- 1. p_skill IS NULL のときは JOIN 自体をスキップ（EXISTS化）し、スキル指定時のみ結合
-- 2. normalize_prefecture() の結果に対する式インデックスを candidates / candidates_archive_light 双方に追加

CREATE INDEX IF NOT EXISTS idx_candidates_norm_prefecture
  ON candidates (data_env, (normalize_prefecture(raw_profile->>'prefecture')))
  WHERE merged_into IS NULL;

CREATE INDEX IF NOT EXISTS idx_cal_norm_prefecture
  ON candidates_archive_light (data_env, (normalize_prefecture(prefecture)));

DROP FUNCTION IF EXISTS prefecture_counts(text, text, text);
CREATE OR REPLACE FUNCTION prefecture_counts(
  p_data_env text,
  p_skill    text    DEFAULT NULL,
  p_period   text    DEFAULT '7d'
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
    AND normalize_prefecture(c.raw_profile->>'prefecture') = p_prefecture
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
