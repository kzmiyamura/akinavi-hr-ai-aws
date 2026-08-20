-- 別の紹介会社から来た同一人材を取り込み時に見つけられるようにする（2026-08-20）
--
-- 背景（実測）:
--   prod 2,132人のうち、氏名＋年齢＋最寄駅が一致し紹介会社だけが違うペアが83組。
--   スキル一致度は平均0.68（8割が 0.4以上）で、ほぼ確実に同一人物。
--   取り込み側（inbound-email）にも別エージェント判定はあったが、入口が
--   `.eq('name', ...)` の**完全一致**だったため取り逃していた。
--   実例: 同じ人が会社によって `H,I` / `H.I`、`FR` / `F.R` と書かれる。
--
-- 既存の正規化（20260814）は `[. \-　・ー]` を除去していたが**カンマが入っていない**。
-- カンマ・全角カンマ・読点・全角ピリオドを追加する。
--
-- 適用: npx supabase db query --linked -f supabase/migrations/20260820_cross_agency_dedup.sql

-- ① 正規化の共通関数（インデックスに使うので IMMUTABLE）
CREATE OR REPLACE FUNCTION normalize_candidate_name(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(upper(coalesce(p_name, '')), '[. ,　、．・ー\-]', '', 'g');
$$;

-- ② 新しい正規化でインデックスを張り直す（旧インデックスは残す。既存RPCがまだ使う）
CREATE INDEX IF NOT EXISTS idx_candidates_name_normalized_v2
  ON candidates (data_env, normalize_candidate_name(name));

-- ③ 取り込み時の同一人物候補を返す。
--    inbound-email は判定材料だけあればよいので、raw_profile 全体は返さない
--    （1件20〜60KB。取り込みのたびに引くと egress が跳ねる）。
CREATE OR REPLACE FUNCTION find_same_person_candidates(
  p_name      text,
  p_data_env  text,
  p_since     timestamptz DEFAULT now() - interval '90 days'
)
RETURNS TABLE (
  id                uuid,
  skills            jsonb,
  experience_years  numeric,
  desired_rate      text,
  from_company      text,
  mail_from         text,
  subject           text,
  nearest_station   text,
  prefecture        text,
  age               int
)
LANGUAGE sql STABLE AS $$
  SELECT c.id,
         c.skills,
         c.experience_years,
         c.desired_rate,
         c.from_company,
         c.raw_profile->>'from',
         c.raw_profile->>'subject',
         c.raw_profile->>'nearestStation',
         c.raw_profile->>'prefecture',
         nullif(c.raw_profile->>'age','')::int
  FROM candidates c
  WHERE c.data_env = p_data_env
    AND c.merged_into IS NULL
    AND c.duplicate_flag = false
    AND c.created_at >= p_since
    AND normalize_candidate_name(c.name) = normalize_candidate_name(p_name)
    AND normalize_candidate_name(c.name) <> ''
  ORDER BY c.created_at DESC
  LIMIT 10;
$$;

-- 確認
SELECT normalize_candidate_name('H,I') AS a,
       normalize_candidate_name('H.I') AS b,
       normalize_candidate_name('F R') AS c,
       (normalize_candidate_name('H,I') = normalize_candidate_name('H.I')) AS 一致するか;
