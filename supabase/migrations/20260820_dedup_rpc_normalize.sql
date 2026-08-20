-- 既存の重複検索RPCを新しい正規化に揃える（2026-08-20）
--
-- マッチング画面の「別ルートの同一人物候補」は find_duplicate_candidates_batch を使うが、
-- 照合が旧正規化 `[. \-　・ー]` でカンマを含まないため、
-- **同じ人が会社ごとに違う表記で来ると拾えなかった**。
--   実例: `H,I`（GFD）と `H.I`（アイスタンダード）、`FR` と `F.R`
-- 実測（prod 2,132人）: 氏名＋年齢＋駅が一致し会社だけ違うペアが83組、
-- スキル一致度は平均0.68（8割が0.4以上）。表示の仕組みはあるのに拾えていなかった。
--
-- normalize_candidate_name（20260820_cross_agency_dedup.sql で追加）に統一する。
-- 返す列・並び順・件数上限は変えない。
--
-- 適用: npx supabase db query --linked -f supabase/migrations/20260820_dedup_rpc_normalize.sql

CREATE OR REPLACE FUNCTION find_duplicate_candidates_batch(
  p_ids      uuid[],
  p_data_env text
)
RETURNS TABLE (
  source_id        uuid,
  id               uuid,
  name             text,
  email            text,
  raw_profile      jsonb,
  skills           jsonb,
  experience_years numeric,
  desired_rate     text,
  from_company     text,
  duplicate_flag   boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH src AS (
    SELECT c.id AS source_id, normalize_candidate_name(c.name) AS norm
    FROM candidates c
    WHERE c.id = ANY(p_ids)
      AND c.data_env = p_data_env
  ),
  ranked AS (
    SELECT
      s.source_id,
      d.id,
      d.name,
      d.email,
      duplicate_profile_slim(d.raw_profile) AS raw_profile,
      d.skills,
      d.experience_years,
      d.desired_rate,
      d.from_company,
      d.duplicate_flag,
      row_number() OVER (PARTITION BY s.source_id ORDER BY d.created_at DESC) AS rn
    FROM src s
    JOIN candidates d
      ON d.data_env = p_data_env
     AND d.id <> s.source_id
     AND normalize_candidate_name(d.name) = s.norm
     AND s.norm <> ''
  )
  SELECT source_id, id, name, email, raw_profile, skills,
         experience_years, desired_rate, from_company, duplicate_flag
  FROM ranked
  WHERE rn <= 10;
$$;
GRANT EXECUTE ON FUNCTION find_duplicate_candidates_batch(uuid[], text) TO anon, authenticated;

-- 単数版も揃える（人材詳細の重複表示が使う）
CREATE OR REPLACE FUNCTION find_duplicate_candidates(
  p_name       text,
  p_exclude_id uuid,
  p_data_env   text
)
RETURNS TABLE (
  id               uuid,
  name             text,
  email            text,
  raw_profile      jsonb,
  skills           jsonb,
  experience_years numeric,
  desired_rate     text,
  from_company     text,
  duplicate_flag   boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.name, c.email, duplicate_profile_slim(c.raw_profile), c.skills,
         c.experience_years, c.desired_rate, c.from_company, c.duplicate_flag
  FROM candidates c
  WHERE c.data_env = p_data_env
    AND c.id <> p_exclude_id
    AND normalize_candidate_name(c.name) = normalize_candidate_name(p_name)
    AND normalize_candidate_name(p_name) <> ''
  ORDER BY c.created_at DESC
  LIMIT 10;
$$;

-- 効果の確認: 旧正規化では拾えず、新正規化なら拾えるペアの数
SELECT '新正規化で増える同一人物ペア' AS 指標, count(*)::text AS 値
FROM candidates a JOIN candidates b
  ON a.data_env = b.data_env AND a.id < b.id
 AND normalize_candidate_name(a.name) = normalize_candidate_name(b.name)
 AND regexp_replace(upper(a.name), '[. \-　・ー]', '', 'g')
   <> regexp_replace(upper(b.name), '[. \-　・ー]', '', 'g')
WHERE a.data_env = 'prod' AND a.merged_into IS NULL AND b.merged_into IS NULL;
