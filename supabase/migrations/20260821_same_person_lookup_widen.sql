-- 同名候補の照会を「本人に届く」ものにする（2026-08-21・不具合修正）
--
-- 症状: 同じ会社・同じ人が別レコードとして毎日増え、「別の紹介会社から来た同一人材」
--       バッジが**同一社内**で出ていた（ユーザー指摘）。
--
-- 原因: 重複判定の入口が「同名を新しい順に10件」だけを見ていた。
--       イニシャル氏名は同名が非常に多く（prod実測 90日: K.K 35件・OK 33件・TK 27件・
--       SY 18件）、本人が10件の外に落ちると毎回「新規」として INSERT される。
--       実測: 同名・同一人物スコア0.4以上のペアのうち **245組が同じ会社**（別会社は84組）。
--
-- 対策: ①最寄駅が一致する行を先頭に並べる（同名多数でも本人を射抜ける）
--       ②取得件数を 10 → 40 に広げる（最大同名数35件を覆う）
--       p_station は省略可能なので、既存の2引数呼び出しはそのまま動く。
--
-- 適用: npx supabase db query --linked -f supabase/migrations/20260821_same_person_lookup_widen.sql

CREATE OR REPLACE FUNCTION find_same_person_candidates(
  p_name      text,
  p_data_env  text,
  p_since     timestamptz DEFAULT now() - interval '90 days',
  p_station   text DEFAULT NULL
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
  ORDER BY
    -- 最寄駅が一致する行を最優先（同名が40件を超えても本人を取り逃さない）
    (p_station IS NOT NULL AND c.raw_profile->>'nearestStation' = p_station) DESC,
    c.created_at DESC
  LIMIT 40;
$$;
GRANT EXECUTE ON FUNCTION find_same_person_candidates(text, text, timestamptz, text) TO anon, authenticated, service_role;

-- 効果確認: 同名が10件を超える氏名がどれだけあるか（従来はこの人たちを取り逃していた）
SELECT count(*) AS 同名10件超の氏名数
FROM (
  SELECT name FROM candidates
  WHERE data_env='prod' AND duplicate_flag=false AND merged_into IS NULL
    AND created_at >= now() - interval '90 days'
  GROUP BY name HAVING count(*) > 10
) t;
