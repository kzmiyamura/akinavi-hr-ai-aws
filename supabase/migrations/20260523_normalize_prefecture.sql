-- 都道府県名の正規化関数
-- 「東京都 大森」→「東京都」、「茨城」→「茨城県」、「日本」「関東」→ NULL など
CREATE OR REPLACE FUNCTION normalize_prefecture(pref text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN pref IS NULL OR pref = '' OR pref = 'null' OR pref IN ('日本','関東','全国','リモート') THEN NULL
    WHEN pref ~ '[a-zA-Z]' THEN NULL
    WHEN pref ~ '^.+[都道府県].+' THEN regexp_replace(pref, '^(.+?[都道府県]).*$', '\1')
    WHEN pref ~ '[都道府県]$' THEN pref
    WHEN pref IN ('茨城','栃木','群馬','埼玉','千葉','神奈川','新潟','富山','石川','福井',
                  '山梨','長野','岐阜','静岡','愛知','三重','滋賀','兵庫','奈良','和歌山',
                  '鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知',
                  '福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄',
                  '青森','岩手','宮城','秋田','山形','福島') THEN pref || '県'
    WHEN pref = '東京' THEN '東京都'
    WHEN pref = '大阪' THEN '大阪府'
    WHEN pref = '京都' THEN '京都府'
    WHEN pref = '北海' THEN '北海道'
    ELSE NULL
  END
$$;

-- prefecture_counts RPC（normalize_prefecture 適用版）
DROP FUNCTION IF EXISTS prefecture_counts(text, text);
CREATE OR REPLACE FUNCTION prefecture_counts(
  p_data_env text,
  p_skill    text    DEFAULT NULL,
  p_period   text    DEFAULT '7d'
)
RETURNS TABLE(prefecture text, cnt bigint)
LANGUAGE sql STABLE AS $$
  WITH live AS (
    SELECT DISTINCT c.id, normalize_prefecture(c.raw_profile->>'prefecture') AS prefecture
    FROM candidates c
    LEFT JOIN candidate_skills cs ON cs.candidate_id = c.id
    WHERE c.data_env = p_data_env
      AND normalize_prefecture(c.raw_profile->>'prefecture') IS NOT NULL
      AND (p_skill IS NULL OR cs.skill ILIKE '%' || p_skill || '%')
  ),
  archived AS (
    SELECT DISTINCT a.id, normalize_prefecture(a.prefecture) AS prefecture
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

-- candidates_by_prefecture RPC（normalize_prefecture 適用版）
CREATE OR REPLACE FUNCTION candidates_by_prefecture(
  p_data_env   text,
  p_prefecture text,
  p_skill      text DEFAULT NULL,
  p_limit      int  DEFAULT 10,
  p_period     text DEFAULT '7d'
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz, is_archived boolean)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT
    c.id, c.name, c.raw_profile->>'subject' AS subject, c.created_at, false AS is_archived
  FROM candidates c
  LEFT JOIN candidate_skills cs ON cs.candidate_id = c.id
  WHERE c.data_env = p_data_env
    AND normalize_prefecture(c.raw_profile->>'prefecture') = p_prefecture
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
    AND (p_skill IS NULL OR cs.skill ILIKE '%' || p_skill || '%')

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
