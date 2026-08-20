-- 同一人物候補の判定を厳しくする（2026-08-20・不具合修正）
--
-- ⚠ 直前の変更（20260820_dedup_rpc_normalize.sql）は**氏名の一致だけ**で返していた。
-- `S.Y` のようなイニシャルは同姓同名が大量にあり、画面には
-- 勝どき駅/宮城県/荻窪駅/北大路駅 の別人が10件並んだ（ユーザー指摘）。
--
-- 取り込み時（inbound-email）と同じ条件をSQL側にも入れる:
--   ・駅が両方あって違う → 別人
--   ・都道府県が両方あって違う → 別人
--   ・年齢が両方あって違う → 別人
--   ・経験年数の差が5年以上 → 別人
--   ・上記を通過し、かつ「スキル一致度(Jaccard) >= 0.4」または「年齢＋駅が一致」
--
-- 実測（prod 2,132人）: この条件に合うペアは83組・スキル一致度は平均0.68。
--
-- 適用: npx supabase db query --linked -f supabase/migrations/20260820_dedup_rpc_stricter.sql

-- 2人が同一人物と言えるかの判定（両RPCで共有する）
CREATE OR REPLACE FUNCTION same_person_score(a candidates, b candidates)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  WITH
  sa AS (SELECT lower(s) AS s FROM jsonb_array_elements_text(coalesce(a.skills,'[]'::jsonb)) s),
  sb AS (SELECT lower(s) AS s FROM jsonb_array_elements_text(coalesce(b.skills,'[]'::jsonb)) s),
  j AS (
    SELECT (SELECT count(*) FROM (SELECT s FROM sa INTERSECT SELECT s FROM sb) x)::numeric AS inter,
           (SELECT count(*) FROM (SELECT s FROM sa UNION     SELECT s FROM sb) y)::numeric AS uni
  ),
  attrs AS (
    SELECT
      nullif(a.raw_profile->>'nearestStation','') AS st_a,
      nullif(b.raw_profile->>'nearestStation','') AS st_b,
      nullif(a.raw_profile->>'prefecture','')     AS pf_a,
      nullif(b.raw_profile->>'prefecture','')     AS pf_b,
      nullif(a.raw_profile->>'age','')::int       AS age_a,
      nullif(b.raw_profile->>'age','')::int       AS age_b
  )
  SELECT CASE
    -- 矛盾があれば別人（0点）
    WHEN attrs.st_a IS NOT NULL AND attrs.st_b IS NOT NULL AND attrs.st_a <> attrs.st_b THEN 0
    WHEN attrs.pf_a IS NOT NULL AND attrs.pf_b IS NOT NULL AND attrs.pf_a <> attrs.pf_b THEN 0
    WHEN attrs.age_a IS NOT NULL AND attrs.age_b IS NOT NULL AND attrs.age_a <> attrs.age_b THEN 0
    WHEN a.experience_years IS NOT NULL AND b.experience_years IS NOT NULL
         AND abs(a.experience_years - b.experience_years) >= 5 THEN 0
    -- 年齢と駅が一致していれば、スキル表記が揃わなくても同一人物とみなす
    WHEN attrs.age_a IS NOT NULL AND attrs.age_a = attrs.age_b
         AND attrs.st_a IS NOT NULL AND attrs.st_a = attrs.st_b THEN 1
    -- それ以外はスキルの一致度で判断
    ELSE CASE WHEN j.uni = 0 THEN 0 ELSE j.inter / j.uni END
  END
  FROM j, attrs;
$$;

CREATE OR REPLACE FUNCTION find_duplicate_candidates_batch(
  p_ids      uuid[],
  p_data_env text
)
RETURNS TABLE (
  source_id uuid, id uuid, name text, email text, raw_profile jsonb, skills jsonb,
  experience_years numeric, desired_rate text, from_company text, duplicate_flag boolean
)
LANGUAGE sql STABLE AS $$
  WITH ranked AS (
    SELECT s.id AS source_id, d.id, d.name, d.email,
           duplicate_profile_slim(d.raw_profile) AS raw_profile,
           d.skills, d.experience_years, d.desired_rate, d.from_company, d.duplicate_flag,
           row_number() OVER (PARTITION BY s.id ORDER BY d.created_at DESC) AS rn
    FROM candidates s
    JOIN candidates d
      ON d.data_env = p_data_env AND d.id <> s.id AND d.merged_into IS NULL
     AND normalize_candidate_name(d.name) = normalize_candidate_name(s.name)
     AND normalize_candidate_name(s.name) <> ''
     AND same_person_score(s, d) >= 0.4
    WHERE s.id = ANY(p_ids) AND s.data_env = p_data_env
  )
  SELECT source_id, id, name, email, raw_profile, skills,
         experience_years, desired_rate, from_company, duplicate_flag
  FROM ranked WHERE rn <= 10;
$$;
GRANT EXECUTE ON FUNCTION find_duplicate_candidates_batch(uuid[], text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION find_duplicate_candidates(
  p_name text, p_exclude_id uuid, p_data_env text
)
RETURNS TABLE (
  id uuid, name text, email text, raw_profile jsonb, skills jsonb,
  experience_years numeric, desired_rate text, from_company text, duplicate_flag boolean
)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.name, d.email, duplicate_profile_slim(d.raw_profile), d.skills,
         d.experience_years, d.desired_rate, d.from_company, d.duplicate_flag
  FROM candidates s
  JOIN candidates d
    ON d.data_env = p_data_env AND d.id <> s.id AND d.merged_into IS NULL
   AND normalize_candidate_name(d.name) = normalize_candidate_name(s.name)
   AND normalize_candidate_name(s.name) <> ''
   AND same_person_score(s, d) >= 0.4
  WHERE s.id = p_exclude_id
  ORDER BY d.created_at DESC
  LIMIT 10;
$$;
GRANT EXECUTE ON FUNCTION find_duplicate_candidates(text, uuid, text) TO anon, authenticated;

-- 効果確認: 氏名だけの一致に比べてどれだけ絞れるか
SELECT '氏名一致だけのペア（誤検知を含む）' AS 指標, count(*)::text AS 値
FROM candidates a JOIN candidates b
  ON a.data_env='prod' AND b.data_env='prod' AND a.id < b.id
 AND a.merged_into IS NULL AND b.merged_into IS NULL
 AND normalize_candidate_name(a.name) = normalize_candidate_name(b.name)
 AND normalize_candidate_name(a.name) <> ''
UNION ALL
SELECT '★ 同一人物と判定されるペア', count(*)::text
FROM candidates a JOIN candidates b
  ON a.data_env='prod' AND b.data_env='prod' AND a.id < b.id
 AND a.merged_into IS NULL AND b.merged_into IS NULL
 AND normalize_candidate_name(a.name) = normalize_candidate_name(b.name)
 AND normalize_candidate_name(a.name) <> ''
 AND same_person_score(a, b) >= 0.4;
