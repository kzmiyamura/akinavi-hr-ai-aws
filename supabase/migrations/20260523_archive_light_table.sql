-- candidates_archive_light: アーカイブ済み人材の都道府県・スキルだけ保持するサマリーテーブル
-- ヒートマップの「全期間」表示に使用。Storage JSONL より高速に集計できる。

CREATE TABLE IF NOT EXISTS candidates_archive_light (
  id          uuid        PRIMARY KEY,
  data_env    text        NOT NULL DEFAULT 'prod',
  prefecture  text,
  skills      jsonb       NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cal_data_env   ON candidates_archive_light(data_env);
CREATE INDEX IF NOT EXISTS idx_cal_prefecture  ON candidates_archive_light(prefecture);

-- prefecture_counts RPC を p_period 対応版に差し替え
-- p_period = '7d'（既定） → candidates のみ（現行DB）
-- p_period = 'all'        → candidates + candidates_archive_light を合算
CREATE OR REPLACE FUNCTION prefecture_counts(
  p_data_env text,
  p_skill    text    DEFAULT NULL,
  p_period   text    DEFAULT '7d'
)
RETURNS TABLE(prefecture text, cnt bigint)
LANGUAGE sql
STABLE
AS $$
  WITH live AS (
    -- 直近7日（常に含む）: スキルフィルタ時は candidate_skills で絞り込み
    SELECT DISTINCT c.id, c.raw_profile->>'prefecture' AS prefecture
    FROM candidates c
    LEFT JOIN candidate_skills cs ON cs.candidate_id = c.id
    WHERE c.data_env = p_data_env
      AND c.raw_profile->>'prefecture' IS NOT NULL
      AND c.raw_profile->>'prefecture' != ''
      AND c.raw_profile->>'prefecture' != '不明'
      AND (p_skill IS NULL OR cs.skill ILIKE '%' || p_skill || '%')
  ),
  archived AS (
    -- アーカイブ分（全期間モードのみ）
    SELECT DISTINCT a.id, a.prefecture
    FROM candidates_archive_light a
    LEFT JOIN LATERAL jsonb_array_elements_text(a.skills) sk ON p_skill IS NOT NULL
    WHERE p_period = 'all'
      AND a.data_env = p_data_env
      AND a.prefecture IS NOT NULL
      AND a.prefecture != ''
      AND a.prefecture != '不明'
      AND (p_skill IS NULL OR sk ILIKE '%' || p_skill || '%')
  ),
  combined AS (
    SELECT id, prefecture FROM live
    UNION -- アーカイブ後も同IDが残る可能性を排除
    SELECT id, prefecture FROM archived
  )
  SELECT prefecture, COUNT(*)::bigint AS cnt
  FROM combined
  GROUP BY prefecture
  ORDER BY cnt DESC;
$$;
