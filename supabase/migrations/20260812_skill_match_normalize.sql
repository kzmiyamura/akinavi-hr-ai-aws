-- スキル一致判定を「部分一致」から「正規化＋語境界」に変える（2026-08-12）
--
-- ■ 何が問題だったか
-- 必須スキルの充足判定が双方向の部分一致だった:
--     lower(s) LIKE '%'||q||'%'  OR  q LIKE '%'||lower(s)||'%'
-- 逆方向（q LIKE '%s%'）が特に有害で、候補者が持つ短いスキル名が
-- 無関係な必須スキルに一致していた。prod 人材2,007件での実測:
--     "C"     を持つ399人 → 「Azure Functions」「Microsoft 365」「C#」に一致
--     "R"     を持つ5人   → ほぼ全ての必須スキルに一致
--     "ROS"   を持つ38人  → 「Microsoft 365」に一致（mic-ROS-oft）
--     "Shell" を持つ329人 → 「PowerShell」に一致
-- 順方向にも別物の一致があった:
--     "JavaScript" を持つ983人 → 「Java」要件に一致
-- 結果、必須スキルがほぼ全員満点近くになり、同日に入れた重み付け（skill_weights）が
-- 順位をほとんど動かせなかった。
--
-- ■ 新しい判定（いずれか1つを満たせば充足）
--   ① 正規化した正式名が一致  … skill_master の別名で寄せる。空白除去・小文字化。
--                              解決できなければ末尾のバージョン番号を落として再試行
--                              （Java8 → Java）。語幹2文字以上かつ既知スキルのときだけ
--   ② 包含関係を満たす        … skill_implications（MySQL を持つ人は SQL 要件を満たす、
--                              の向きだけ。逆は成り立たない）
--   ③ 必須スキルを語として含む … 前後が英数字・#・+ でない
--        java ⊄ javascript（直後が s）  java ⊂ oracle java se   c# ⊂ c#.net
--        sql ⊂ pl/sql, t-sql, sql server    sql ⊄ mysql, postgresql（→②で救う）
-- 逆方向の部分一致は廃止する。
--
-- ■ 影響（prod 人材2,007件・案件8件での実測。必須スキルごとの充足人数）
--     Azure Functions 656→14 / Microsoft 365 592→201 / PowerShell 457→195
--     Java 1,232→984 / C# 702→463 / Spring Boot 430→213
--     SQL 1,473→1,566（②の包含関係で製品名だけの人を救うため増える）
--     EntraID 5→37（"Entra ID" の空白を吸収するため増える）
-- 主要案件（PowerShell/Azure Functions）の上位20名で「Shellだけの人」が15名→1名。
--
-- ■ 営業判断（2026-08-12 ユーザー確認済み）
--   ・MySQL/PostgreSQL 等の製品名しか書いていない人も SQL 要件を満たす（②で救う）
--   ・Spring だけの人は Spring Boot 要件を満たさない（包含関係を作らない）
--
-- ■ 関連ファイル
--   scripts/sql/test_skill_matching.sql            判定の単体テスト
--   scripts/sql/test_skill_matching_rpc_parity.sql 定義と実体が食い違っていないかの確認
--   scripts/sql/audit_skill_requirement_coverage.sql 必須スキルごとの充足人数

-- ============================================================
-- 1. 正規化辞書
-- ============================================================

-- 小文字化＋空白除去。inbound-email 側の照合キー生成と同じ規則に揃えている
-- （index.ts の getSkillNameSet: name.toLowerCase().replace(/\s+/g, '')）
CREATE OR REPLACE FUNCTION public.skill_key(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT lower(regexp_replace(coalesce(trim(p_text), ''), '\s+', '', 'g')) $$;

COMMENT ON FUNCTION public.skill_key(text) IS
  'スキル名の照合キー（小文字化＋空白除去）。skill_norm_map の検索キーに使う';

-- 正規化キー → 正式名（小文字）。正式名の行を別名より優先する
-- （例: "mysql" は MySQL の正式名として解決され、他スキルの別名には吸われない）
--
-- ただのビューにすると skill_canon() を呼ぶたびに skill_master 全件＋aliases の
-- jsonb 展開が走り、1件ずつ判定する用途で statement timeout に達したので実体化する。
DROP MATERIALIZED VIEW IF EXISTS public.skill_norm_map CASCADE;

CREATE MATERIALIZED VIEW public.skill_norm_map AS
SELECT DISTINCT ON (k) k, canon
FROM (
  SELECT skill_key(m.name) AS k, lower(m.name) AS canon, 0 AS pri
    FROM skill_master m
   WHERE trim(m.name) != ''
  UNION ALL
  SELECT skill_key(a), lower(m.name), 1
    FROM skill_master m, jsonb_array_elements_text(m.aliases) a
   WHERE trim(a) != ''
) t
ORDER BY k, pri;

COMMENT ON MATERIALIZED VIEW public.skill_norm_map IS
  'skill_master の正式名＋別名から作る正規化辞書。skill_master 更新時にトリガで貼り直す';

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_norm_map_k ON public.skill_norm_map(k);

GRANT SELECT ON public.skill_norm_map TO anon, authenticated;

-- skill_master は日常的には変わらない（add_skill.mjs かマイグレーションのときだけ）。
-- 変更を取りこぼすと正規化が古いままになるので自動で貼り直す
CREATE OR REPLACE FUNCTION public.refresh_skill_norm_map()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.skill_norm_map;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_skill_norm_map ON public.skill_master;
CREATE TRIGGER trg_refresh_skill_norm_map
AFTER INSERT OR UPDATE OR DELETE ON public.skill_master
FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_skill_norm_map();

-- ============================================================
-- 2. スキルの包含関係（向きのある関係）
-- ============================================================

-- child を持つ人は parent の要件も満たす。逆は成り立たない。
-- skill_master の別名では表現できない（MySQL は独立したスキルなので
-- SQL の別名にすると MySQL 要件に PostgreSQL の人が一致してしまう）。
CREATE TABLE IF NOT EXISTS public.skill_implications (
  child      text NOT NULL,   -- 候補者が持っているスキル（正式名・小文字）
  parent     text NOT NULL,   -- それで満たせる必須スキル（正式名・小文字）
  note       text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (child, parent)
);

COMMENT ON TABLE public.skill_implications IS
  '「childを持つ人はparent要件も満たす」向きのある包含関係。マッチングのスキル充足判定で使う';

ALTER TABLE public.skill_implications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skill_implications_select_all ON public.skill_implications;
CREATE POLICY skill_implications_select_all
  ON public.skill_implications FOR SELECT TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_skill_implications_parent
  ON public.skill_implications(parent);

-- RDBMS・DWH製品の経験は SQL 要件を満たす（2026-08-12 ユーザー判断）。
-- 「SQLマスターみたいなイメージ」＝製品名で書く人をSQL案件から落としたくない、という営業判断。
-- NoSQL（MongoDB/Redis/DynamoDB/Cassandra/Elasticsearch）は SQL を使わないので入れない。
INSERT INTO public.skill_implications (child, parent, note) VALUES
  ('mysql',              'sql', 'RDBMS'),
  ('mariadb',            'sql', 'RDBMS'),
  ('postgresql',         'sql', 'RDBMS'),
  ('oracle database',    'sql', 'RDBMS'),
  ('sql server',         'sql', 'RDBMS'),
  ('sqlite',             'sql', 'RDBMS'),
  ('db2',                'sql', 'RDBMS'),
  ('aurora',             'sql', 'RDBMS'),
  ('azure sql',          'sql', 'RDBMS'),
  ('azure sql database', 'sql', 'RDBMS'),
  ('cloud sql',          'sql', 'RDBMS'),
  ('tidb',               'sql', 'RDBMS'),
  ('cockroachdb',        'sql', 'RDBMS'),
  ('singlestore',        'sql', 'RDBMS'),
  ('timescaledb',        'sql', 'RDBMS'),
  ('citus',              'sql', 'RDBMS'),
  ('pl/sql',             'sql', 'RDBMS'),
  ('t-sql',              'sql', 'RDBMS'),
  ('snowflake',          'sql', 'DWH'),
  ('bigquery',           'sql', 'DWH'),
  ('google bigquery',    'sql', 'DWH'),
  ('amazon redshift',    'sql', 'DWH'),
  ('redshift',           'sql', 'DWH'),
  ('azure synapse',      'sql', 'DWH'),
  ('athena',             'sql', 'DWH'),
  ('trino',              'sql', 'DWH'),
  ('presto',             'sql', 'DWH'),
  ('apache hive',        'sql', 'DWH'),
  ('databricks',         'sql', 'DWH')
ON CONFLICT (child, parent) DO NOTHING;

-- ============================================================
-- 3. 判定の「定義」（読める形。テストの期待値に使う）
-- ============================================================

-- 正規化: skill_master の別名で正式名（小文字）に寄せる。
-- 解決できなければ末尾のバージョン番号を落として再試行する（Java8 → Java）。
-- 語幹が2文字未満、または既知スキルでない場合は落とさない（S3 → S にしない）。
CREATE OR REPLACE FUNCTION public.skill_canon(p_skill text)
RETURNS text
LANGUAGE sql STABLE
AS $$
  WITH k AS (SELECT skill_key(p_skill) AS k),
  stem AS (SELECT regexp_replace(k.k, '[0-9.]+$', '') AS s FROM k)
  SELECT COALESCE(
    (SELECT m.canon FROM skill_norm_map m, k WHERE m.k = k.k),
    (SELECT m.canon FROM skill_norm_map m, k, stem
      WHERE k.k ~ '[0-9.]$' AND length(stem.s) >= 2 AND m.k = stem.s),
    (SELECT k.k FROM k)
  )
$$;

COMMENT ON FUNCTION public.skill_canon(text) IS
  'スキル名を skill_master の正式名（小文字）に正規化する。未知の表記は正規化キーのまま返す';

-- 候補者スキル p_have が必須スキル p_want を満たすか。
-- 性能のため実際のマッチングは skill_hit_weights() の集合演算で計算するが、
-- 判定の定義はこちら。両者が一致することは test_skill_matching_rpc_parity.sql で確認する。
CREATE OR REPLACE FUNCTION public.skill_satisfies(p_have text, p_want text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT
    -- ① 正規化した正式名が一致
    skill_canon(p_have) = skill_canon(p_want)
    -- ② 包含関係（MySQL を持つ人は SQL 要件を満たす。逆は成り立たない）
    OR EXISTS (
      SELECT 1 FROM skill_implications i
       WHERE i.child = skill_canon(p_have) AND i.parent = skill_canon(p_want)
    )
    -- ③ 必須スキルを語として含む（前後が英数字・#・+ でない）
    OR lower(trim(p_have)) ~ (
         '(^|[^a-z0-9#+])' ||
         regexp_replace(lower(trim(p_want)), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') ||
         '([^a-z0-9#+]|$)'
       )
$$;

COMMENT ON FUNCTION public.skill_satisfies(text, text) IS
  '候補者スキル(第1引数)が必須スキル(第2引数)を満たすかの判定の定義。向きがあるので引数の順序に注意';

-- ============================================================
-- 4. 判定の実体（集合演算版。マッチングとauto-matchが共通で使う）
-- ============================================================

-- 同じ判定が2か所にあった:
--   ① fetch_candidates_for_project（SQL）
--   ② auto-match Edge Function（TypeScript。AI採点にかける候補者の事前フィルタ）
-- ②が旧ルールのままだと "C" を持つ399人が Azure Functions 案件の採点対象に入るので、
-- 判定をここに集約して両方から呼ぶ。
--
-- 指定した必須スキルに対して、候補者ごとの「満たせた必須スキルの重み合計」を返す。
-- 1つも満たしていない候補者は返さない。
CREATE OR REPLACE FUNCTION public.skill_hit_weights(
  p_data_env        text,
  p_required_skills text[],
  p_skill_weights   jsonb DEFAULT NULL
)
RETURNS TABLE(candidate_id uuid, hit_w numeric)
LANGUAGE sql
STABLE
AS $$
  WITH v AS (
    SELECT array_agg(lower(trim(x))) AS skills
      FROM unnest(COALESCE(p_required_skills, ARRAY[]::text[])) x
     WHERE trim(x) != ''
  ),
  map AS MATERIALIZED (SELECT k, canon FROM skill_norm_map),
  req0 AS (
    -- 必須スキルと、その重み（skill_weights に無いものは1）
    SELECT q AS name,
           COALESCE((SELECT GREATEST(e.value::numeric, 0)
                       FROM jsonb_each_text(COALESCE(p_skill_weights, '{}'::jsonb)) e
                      WHERE lower(e.key) = q), 1) AS w,
           skill_key(q) AS qk
      FROM v, unnest(COALESCE(v.skills, ARRAY[]::text[])) q
  ),
  req AS (
    SELECT req0.name, req0.w,
           COALESCE(m.canon, req0.qk) AS canon,
           -- 語境界パターン。前後が英数字・#・+ でないときだけ一致とみなす
           '(^|[^a-z0-9#+])' ||
           regexp_replace(req0.name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') ||
           '([^a-z0-9#+]|$)' AS pat
      FROM req0 LEFT JOIN map m ON m.k = req0.qk
  ),
  cs AS MATERIALIZED (
    SELECT c.id, lower(trim(s.value)) AS s, skill_key(s.value) AS sk
      FROM candidates c
      CROSS JOIN LATERAL jsonb_array_elements_text(c.skills) s(value)
     WHERE c.data_env       = p_data_env
       AND c.merged_into    IS NULL
       AND c.duplicate_flag = false
       AND trim(s.value)    != ''
  ),
  csc AS (
    -- 正式名に寄せる。解決できなければ末尾のバージョン番号を落として再試行（Java8 → Java）
    SELECT cs.id, cs.s, COALESCE(m1.canon, m2.canon, cs.sk) AS s_canon
      FROM cs
      LEFT JOIN map m1 ON m1.k = cs.sk
      LEFT JOIN map m2 ON m1.canon IS NULL
                      AND cs.sk ~ '[0-9.]$'
                      AND length(regexp_replace(cs.sk, '[0-9.]+$', '')) >= 2
                      AND m2.k = regexp_replace(cs.sk, '[0-9.]+$', '')
  ),
  hit AS (
    SELECT DISTINCT u.id, u.name FROM (
      -- ① 正規化した正式名が一致
      SELECT csc.id, r.name FROM csc JOIN req r ON r.canon = csc.s_canon
      UNION ALL
      -- ② 包含関係（MySQL を持つ人は SQL 要件を満たす）
      SELECT csc.id, r.name
        FROM csc JOIN skill_implications i ON i.child = csc.s_canon
                 JOIN req r ON r.canon = i.parent
      UNION ALL
      -- ③ 必須スキルを語として含む（LIKE は正規表現の前段の絞り込み）
      SELECT csc.id, r.name
        FROM csc JOIN req r ON csc.s LIKE '%' || r.name || '%' AND csc.s ~ r.pat
    ) u
  )
  SELECT hit.id, SUM(r.w)
    FROM hit JOIN req r ON r.name = hit.name
   GROUP BY hit.id
$$;

COMMENT ON FUNCTION public.skill_hit_weights(text, text[], jsonb) IS
  '必須スキルに対する候補者ごとの充足重み合計。1つも満たさない候補者は返さない。'
  'fetch_candidates_for_project と auto-match が共通で使うスキル一致判定の実体';

GRANT EXECUTE ON FUNCTION public.skill_hit_weights(text, text[], jsonb)
  TO anon, authenticated, service_role;

-- ============================================================
-- 5. 画面表示用（どのスキルがどの必須スキルを満たしたか）
-- ============================================================

-- マッチング画面は「必須スキルが満たされているか」を緑／取り消し線で出している。
-- ここが配点と違う判定だと、点が入っていないのに緑に見える。
-- 判定を持ち込まずに済むよう、満たしている組だけを返す。
-- 画面に出ている候補者のスキル（重複除去）と案件の必須スキルを渡して1回呼ぶ想定。
CREATE OR REPLACE FUNCTION public.match_skill_strings(
  p_have text[],
  p_want text[]
)
RETURNS TABLE(have text, want text)
LANGUAGE sql STABLE
AS $$
  SELECT h, w
    FROM unnest(COALESCE(p_have, ARRAY[]::text[])) h,
         unnest(COALESCE(p_want, ARRAY[]::text[])) w
   WHERE skill_satisfies(h, w)
$$;

COMMENT ON FUNCTION public.match_skill_strings(text[], text[]) IS
  '候補者スキル×必須スキルのうち、満たしている組だけを返す。マッチング画面の表示用';

GRANT EXECUTE ON FUNCTION public.match_skill_strings(text[], text[]) TO anon, authenticated;

-- ============================================================
-- 6. マッチングRPCを新しい判定に載せ替える
-- ============================================================

DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);

CREATE FUNCTION public.fetch_candidates_for_project(
  p_data_env          text,
  p_required_skills   text[]  DEFAULT NULL,
  p_budget_min        numeric DEFAULT NULL,
  p_budget_max        numeric DEFAULT NULL,
  p_work_location     text    DEFAULT NULL,
  p_remote_policy     text    DEFAULT NULL,
  p_limit             integer DEFAULT 500,
  p_weight_skill      integer DEFAULT 40,
  p_weight_exp        integer DEFAULT 15,
  p_weight_rate       integer DEFAULT 15,
  p_weight_location   integer DEFAULT 20,
  p_weight_remote     integer DEFAULT 10,
  p_require_haken     boolean DEFAULT false,
  p_work_prefecture   text    DEFAULT NULL,
  p_required_exp_years integer DEFAULT NULL,
  p_skill_weights     jsonb   DEFAULT NULL
)
RETURNS SETOF candidates_lite
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_skills          text[];
  v_skills_len      int;
  v_total_weight    numeric;
  v_work_pref_core  text;
  v_work_region     text;
  v_is_full_remote  boolean;
  v_project_has_remote boolean;
BEGIN
  PERFORM set_config('statement_timeout', '30000', true);

  IF p_required_skills IS NOT NULL AND array_length(p_required_skills, 1) > 0 THEN
    SELECT array_agg(lower(trim(x)))
      INTO v_skills
      FROM unnest(p_required_skills) x
     WHERE trim(x) != '';
    v_skills_len := coalesce(array_length(v_skills, 1), 0);
  ELSE
    v_skills     := NULL;
    v_skills_len := 0;
  END IF;

  -- 必須スキル全体の重み合計。skill_weights のキーは元の表記なので小文字で突き合わせる
  SELECT COALESCE(SUM(
           COALESCE((SELECT GREATEST(e.value::numeric, 0)
                       FROM jsonb_each_text(COALESCE(p_skill_weights, '{}'::jsonb)) e
                      WHERE lower(e.key) = q), 1)
         ), 0)
    INTO v_total_weight
    FROM unnest(COALESCE(v_skills, ARRAY[]::text[])) q;

  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';
  v_project_has_remote := v_is_full_remote OR COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅';

  -- 正規化済みの work_prefecture があればそれを正とする。
  -- 無いときだけ従来どおり work_location の文字列から切り出す（後方互換）
  IF COALESCE(trim(p_work_prefecture), '') != '' THEN
    v_work_pref_core := COALESCE(
      (regexp_match(p_work_prefecture, '(\S+?)[都道府県]'))[1],
      trim(p_work_prefecture)
    );
  ELSE
    v_work_pref_core := COALESCE(
      (regexp_match(p_work_location, '(\S+?)[都道府県]'))[1],
      regexp_replace(
        split_part(trim(COALESCE(p_work_location, '')), ' ', 1),
        '(市|区|町|村|郡).*$', ''
      )
    );
  END IF;
  v_work_region := get_region(v_work_pref_core);

  RETURN QUERY
  WITH hw AS MATERIALIZED (
    -- 必須スキルの充足はここに集約している（auto-match も同じ関数を呼ぶ）
    SELECT candidate_id, hit_w
      FROM skill_hit_weights(p_data_env, p_required_skills, p_skill_weights)
  ),
  pre AS (
    SELECT
      c.id,
      COALESCE(
        (regexp_match(c.raw_profile->>'prefecture', '(\S+?)[都道府県]'))[1],
        regexp_replace(
          split_part(trim(COALESCE(c.raw_profile->>'prefecture', '')), ' ', 1),
          '(市|区|町|村|郡).*$', ''
        )
      ) AS pref_core,
      NULLIF(REGEXP_REPLACE(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, ''), '[^0-9.]', '', 'g'), '')::numeric AS rate_val,
      COALESCE(hw.hit_w, 0) AS hit_w
    FROM candidates_lite c
    LEFT JOIN hw ON hw.candidate_id = c.id
    WHERE c.data_env    = p_data_env
      AND c.merged_into IS NULL
      AND c.duplicate_flag = false
      AND (
        NOT p_require_haken
        OR EXISTS (
          SELECT 1 FROM agent_companies ac
          WHERE ac.domain = LOWER(SPLIT_PART(c.raw_profile->>'from', '@', 2))
            AND ac.license_status IN ('haken', 'both')
        )
      )
  )
  SELECT c.*
  FROM candidates_lite c
  JOIN pre ON pre.id = c.id
  CROSS JOIN LATERAL (
    SELECT
      GREATEST(0,
        ROUND(CASE
            WHEN v_skills_len = 0 OR v_total_weight = 0 THEN 20.0/40.0
            WHEN pre.hit_w = 0                          THEN 0.0
            ELSE LEAST(pre.hit_w / v_total_weight, 1.0)
          END * p_weight_skill)
        + ROUND(CASE
            -- 案件が必要年数を明示している場合は「要件を満たすか」で採点する
            WHEN p_required_exp_years IS NOT NULL AND p_required_exp_years > 0 THEN
              CASE
                WHEN c.experience_years IS NULL                              THEN 8.0/15.0
                WHEN c.experience_years >= p_required_exp_years              THEN 1.0
                WHEN c.experience_years >= p_required_exp_years - 1          THEN 8.0/15.0
                WHEN c.experience_years >= p_required_exp_years - 2          THEN 4.0/15.0
                ELSE 0.0
              END
            WHEN c.experience_years IS NULL THEN 8.0/15.0
            WHEN c.experience_years >= 10   THEN 1.0
            WHEN c.experience_years >= 7    THEN 12.0/15.0
            WHEN c.experience_years >= 5    THEN 8.0/15.0
            WHEN c.experience_years >= 3    THEN 4.0/15.0
            WHEN c.experience_years >= 1    THEN 2.0/15.0
            ELSE 0.0
          END * p_weight_exp)
        + ROUND(CASE
            WHEN p_budget_max IS NULL          THEN 1.0
            WHEN pre.rate_val IS NULL          THEN 0.0
            WHEN pre.rate_val <= p_budget_max  THEN 1.0
            WHEN pre.rate_val <= p_budget_max * 1.1 THEN 8.0/15.0
            WHEN pre.rate_val <= p_budget_max * 1.2 THEN 3.0/15.0
            ELSE 0.0
          END * p_weight_rate)
        + ROUND(CASE
            WHEN v_is_full_remote THEN 1.0
            WHEN COALESCE(v_work_pref_core, '') = '' THEN 5.0/20.0
            WHEN COALESCE(c.raw_profile->>'prefecture','') = ''  THEN 5.0/20.0
            WHEN pre.pref_core != ''
                 AND v_work_pref_core != ''
                 AND pre.pref_core = v_work_pref_core              THEN 1.0
            WHEN pre.pref_core != ''
                 AND v_work_region IS NOT NULL
                 AND get_region(pre.pref_core) = v_work_region  THEN 0.5
            ELSE 0.0
          END * p_weight_location)
        + ROUND(CASE
            WHEN (c.raw_profile->>'wantsFullRemote')::boolean = true
                 AND NOT v_project_has_remote                       THEN -1.0
            WHEN v_is_full_remote                                   THEN 0.0
            WHEN (c.raw_profile->>'remoteAvailable')::boolean = true
                 AND COALESCE(p_remote_policy,'') ~ 'リモート|remote|在宅' THEN 1.0
            WHEN (c.raw_profile->>'remoteAvailable') IS NULL        THEN 0.5
            ELSE 0.0
          END * p_weight_remote)
      ) AS rule_score
  ) rs
  WHERE c.data_env      = p_data_env
    AND c.merged_into   IS NULL
    AND c.duplicate_flag = false
    AND (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)
  ORDER BY rs.rule_score DESC, c.created_at DESC
  LIMIT p_limit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fetch_candidates_for_project(
  text, text[], numeric, numeric, text, text, integer, integer, integer,
  integer, integer, integer, boolean, text, integer, jsonb
) TO anon, authenticated;
