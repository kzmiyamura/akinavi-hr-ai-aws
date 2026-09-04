-- 人材マップのスキル絞り込みを語境界一致にする（2026-08-31）
--
-- 実害: 人材マップだけ ILIKE '%Java%' の部分一致のままで、JavaScript を持つ人が
--       Java の枠に入っていた。実測（prod・2026-08-31）で「Java」で絞ると 1,255人が
--       ヒットするが、本当に Java を持つのは 974人。281人（22.4%）が誤り。
--       「Go」では MongoDB・Django・Google 等が一致し 486人まで膨らんでいた。
--
-- CLAUDE.md §6 の鉄則「部分一致は使わない」はマッチング・人材画面には適用済みだが、
-- 人材マップの RPC だけ取り残されていた。
--
-- 【性能について】
-- 最初 skill_satisfies() をそのまま使ったところ statement timeout になった。
-- この RPC は 20260707_fix_heatmap_perf.sql で一度性能改善された経緯があり、
-- 全候補者×全スキルに正規化・包含関係の判定を掛けると重すぎる。
-- そこで「速い前段（ILIKE）で候補を絞り、残った少数だけ語境界の正規表現で判定する」
-- 二段構えにする。ILIKE は語境界一致の上位集合なので取りこぼしは出ない。
--
-- 【この修正で拾えないもの】
-- skill_master の別名（表記ゆれ）と skill_implications の包含関係は見ていない。
-- マッチング側（skill_satisfies）はそこまで見るが、人材マップは件数の俯瞰が目的で、
-- 性能を優先した。必要になったら skill_norm_map を使う形で見直す。

-- 語として一致するか（前後が英数字・#・+ でない）。skill_satisfies の③と同じ判定
CREATE OR REPLACE FUNCTION public.skill_word_match(p_have text, p_want text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(trim(p_have)) ~ (
    '(^|[^a-z0-9#+])' ||
    regexp_replace(lower(trim(p_want)), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') ||
    '([^a-z0-9#+]|$)'
  )
$$;

COMMENT ON FUNCTION public.skill_word_match(text, text) IS
  '語境界つきのスキル一致（人材マップ用）。別名・包含関係は見ない。正は skill_satisfies';

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
          WHERE cs.candidate_id = c.id
            AND cs.skill ILIKE '%' || p_skill || '%'          -- 速い前段
            AND skill_word_match(cs.skill, p_skill)            -- 語境界で確定
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
        WHERE cs.candidate_id = c.id
          AND cs.skill ILIKE '%' || p_skill || '%'
          AND skill_word_match(cs.skill, p_skill)
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
          AND skill_word_match(sk, p_skill)
      )
    )

  ORDER BY created_at DESC
  LIMIT p_limit;
$$;
