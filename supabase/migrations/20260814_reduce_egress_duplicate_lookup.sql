-- Egress削減: マッチング画面の「別ルートの同一人物候補」検索
--
-- 問題（2026-08-14 実測）:
--   案件を1件選ぶたびに find_duplicate_candidates を上位100人ぶん並列で叩いており、
--   さらにこの RPC は raw_profile を**丸ごと**返していた（1コール平均 185KB）。
--   案件1クリックあたり 12MB。画面全体 15.9MB のうち 76% を占めていた。
--
--   20260609_reduce_egress_strip_rawprofile.sql で candidates_lite（text/parsedGrid を落とす）
--   を作って他の RPC は全部そちらに寄せたが、この RPC だけ candidates 直参照で取り残されていた。
--
-- 対策:
--   ① N+1 をやめて1回で引く batch 版を追加（100往復 → 1往復）
--   ② raw_profile は画面が実際に読む5キーだけ返す
--      （nearestStation / prefecture / from / subject / emailReceivedAt）
--      - nearestStation・prefecture: calcDuplicateScore の別人判定
--      - from・subject: 同一メール由来の重複除去
--      - emailReceivedAt: 受信日時の表示
--   ③ 正規化名の関数インデックスを張る（batch 化で全表走査が1回になるが、
--      それでも人材が増えると効くため）
--
-- 見込み: 12MB → 100KB 未満（約99%削減）

-- ① 正規化名のインデックス
-- upper() / regexp_replace() はどちらも IMMUTABLE なので関数インデックスに使える。
-- 正規化式は find_duplicate_candidates の WHERE 句と**完全に同一**でなければ効かない。
CREATE INDEX IF NOT EXISTS idx_candidates_name_normalized
  ON candidates (data_env, (regexp_replace(upper(name), '[. \-　・ー]', '', 'g')));

-- ② 画面が読む5キーだけの raw_profile を組み立てるヘルパ
-- jsonb_strip_nulls で存在しないキーを落とす（1行あたり数十バイトに収まる）
CREATE OR REPLACE FUNCTION duplicate_profile_slim(p_raw jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'nearestStation',  p_raw->'nearestStation',
    'prefecture',      p_raw->'prefecture',
    'from',            p_raw->'from',
    'subject',         p_raw->'subject',
    'emailReceivedAt', p_raw->'emailReceivedAt'
  ));
$$;
GRANT EXECUTE ON FUNCTION duplicate_profile_slim(jsonb) TO anon, authenticated;

-- ③ batch 版: 複数人材ぶんの同一人物候補を1回で返す
-- 返却行に source_id（どの人材に対する候補か）が付く点だけが単数版との差。
-- 1人あたり上位10件までは単数版と同じ。
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
    SELECT
      c.id AS source_id,
      regexp_replace(upper(c.name), '[. \-　・ー]', '', 'g') AS norm
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
     AND regexp_replace(upper(d.name), '[. \-　・ー]', '', 'g') = s.norm
  )
  SELECT source_id, id, name, email, raw_profile, skills,
         experience_years, desired_rate, from_company, duplicate_flag
  FROM ranked
  WHERE rn <= 10;
$$;
GRANT EXECUTE ON FUNCTION find_duplicate_candidates_batch(uuid[], text) TO anon, authenticated;

-- ④ 単数版も raw_profile を絞る（シグネチャ・列構成・並び順は据え置き）
-- 呼び出し側が残っていても egress が膨らまないようにするため。
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
  SELECT
    c.id,
    c.name,
    c.email,
    duplicate_profile_slim(c.raw_profile),
    c.skills,
    c.experience_years,
    c.desired_rate,
    c.from_company,
    c.duplicate_flag
  FROM candidates c
  WHERE c.data_env    = p_data_env
    AND c.id         != p_exclude_id
    AND regexp_replace(upper(c.name), '[. \-　・ー]', '', 'g')
      = regexp_replace(upper(p_name), '[. \-　・ー]', '', 'g')
  ORDER BY c.created_at DESC
  LIMIT 10;
$$;
