-- マッチングで「スキル年数」と「居住地」をマストにするための部品（2026-10-31）
--
-- 営業の指摘「マッチングが精度悪すぎて使い物になってない」「求める居住地とスキル年数はマスト」。
-- 公開中の15案件の上位5人（75人）を本番で突き合わせた実測:
--   ・生産管理（VB.net 保守）の上位5人に VB.net を持つ人が0人。1位は iOS エンジニア
--   ・C#.NET の案件で、C# の年数を持つ人が0人に見える（下の①）
--   ・案件が「Java 10年以上」と書いていても、年数で絞っていない（345人が候補）
-- 方針（ユーザー判断 2026-10-31「しっかりテストして良かったら入れて」）:
--   ・案件が年数を書いた技術は、年数が届かない人・年数が取れていない人を外す
--   ・年数の指定が無い技術は外さず、年数が取れていない人の点を半分にする
--   ・年数を見るのは技術（言語・FW・DB・クラウド・ツール等）だけ。工程（テスト・要件定義）や
--     英語は見ない。経歴書から工程の年数はほとんど取れず、物流案件が0人になった（実測）
--
-- 判定は全部 skill_satisfies（スキル一致の定義）に乗せる。「その必須スキルを満たす
-- スキルに年数が付いているか」で見るので、MySQL 5年の人は SQL の年数ありになる。

-- ============================================================
-- ① C#.NET を C# に寄せる
-- ============================================================
-- C# 行が別名に C#.NET を持っているのに、C#.NET という**別の行**もあった。
-- skill_norm_map は正式名の行を優先するので「c#.net」は C#.NET 行に解決され、
-- C# とは別スキルになる。案件「販売管理（C#・VB.NET）」の必須 C#.NET に対して、
-- C# の年数を持つ人が1人も繋がらなかった（本番実測: 年数ありで残る人 0人）。
-- スキル一致は ③語として含む で救われていたので、壊れていたのは年数の照合だけ。
-- 新しい行は作らず、既存の C# 行に別名を寄せて C#.NET 行を消す（skill_master の運用ルール）
UPDATE skill_master
   SET aliases = (SELECT jsonb_agg(DISTINCT a) FROM jsonb_array_elements_text(aliases || '["csharp.net","c sharp .net"]'::jsonb) a)
 WHERE name = 'C#';
DELETE FROM skill_master WHERE name = 'C#.NET';
REFRESH MATERIALIZED VIEW skill_norm_map;

-- ============================================================
-- ② 必須スキルの充足を「組」で返す（skill_hit_weights の中身を外に出した）
-- ============================================================
-- 年数が取れているかは「どの必須スキルを満たしたか」ごとに見る必要があるが、
-- skill_hit_weights は人ごとの合計しか返さない。判定を2か所に書かないよう、
-- 組を返す関数に本体を移し、skill_hit_weights はその合計にする。
--
-- p_from_years = true のときは、照合する側を skills 配列ではなく raw_profile.skillYears の
-- キー（年数 > 0 のもの）にして、満たした必須スキルごとに最長の月数を返す。
-- 「その必須スキルを満たすスキルに年数が付いているか」を、スキル一致と**同じ規則・同じ集合演算**で出す。
-- 1人ずつ skill_years_meets で見ると、1案件 67秒かかった（本番実測。旧版は5秒）
CREATE OR REPLACE FUNCTION public.skill_hit_pairs(
  p_data_env        text,
  p_required_skills text[],
  p_skill_weights   jsonb DEFAULT NULL,
  p_from_years      boolean DEFAULT false
)
RETURNS TABLE(candidate_id uuid, name text, w numeric, months numeric)
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
    SELECT c.id, lower(trim(s.value)) AS s, skill_key(s.value) AS sk, s.months
      FROM candidates c
      CROSS JOIN LATERAL (
        SELECT x AS value, NULL::numeric AS months
          FROM jsonb_array_elements_text(c.skills) x
         WHERE NOT p_from_years
        UNION ALL
        -- 年数の表。_ 始まりは内部キー（_totalProjectMonths 等）、0 は取れていないのと同じ
        SELECT e.key, (e.value #>> '{}')::numeric
          FROM jsonb_each(CASE WHEN p_from_years AND jsonb_typeof(c.raw_profile->'skillYears') = 'object'
                               THEN c.raw_profile->'skillYears' ELSE '{}'::jsonb END) e
         WHERE left(e.key, 1) <> '_'
           AND jsonb_typeof(e.value) = 'number'
           AND (e.value #>> '{}')::numeric > 0
      ) s
     WHERE c.data_env       = p_data_env
       AND c.merged_into    IS NULL
       AND c.duplicate_flag = false
       AND trim(s.value)    != ''
  ),
  csc AS (
    -- 正式名に寄せる。解決できなければ末尾のバージョン番号を落として再試行（Java8 → Java）
    SELECT cs.id, cs.s, cs.months, COALESCE(m1.canon, m2.canon, cs.sk) AS s_canon
      FROM cs
      LEFT JOIN map m1 ON m1.k = cs.sk
      LEFT JOIN map m2 ON m1.canon IS NULL
                      AND cs.sk ~ '[0-9.]$'
                      AND length(regexp_replace(cs.sk, '[0-9.]+$', '')) >= 2
                      AND m2.k = regexp_replace(cs.sk, '[0-9.]+$', '')
  ),
  hit AS (
    SELECT u.id, u.name, max(u.months) AS months FROM (
      -- ① 正規化した正式名が一致
      SELECT csc.id, r.name, csc.months FROM csc JOIN req r ON r.canon = csc.s_canon
      UNION ALL
      -- ② 包含関係（MySQL を持つ人は SQL 要件を満たす）
      SELECT csc.id, r.name, csc.months
        FROM csc JOIN skill_implications i ON i.child = csc.s_canon
                 JOIN req r ON r.canon = i.parent
      UNION ALL
      -- ③ 必須スキルを語として含む（LIKE は正規表現の前段の絞り込み）
      SELECT csc.id, r.name, csc.months
        FROM csc JOIN req r ON csc.s LIKE '%' || r.name || '%' AND csc.s ~ r.pat
    ) u
    GROUP BY u.id, u.name
  )
  SELECT hit.id, hit.name, r.w, hit.months
    FROM hit JOIN req r ON r.name = hit.name
$$;

COMMENT ON FUNCTION public.skill_hit_pairs(text, text[], jsonb, boolean) IS
  '必須スキルの充足を（候補者, 満たした必須スキル（小文字）, 重み, 月数）の組で返す。'
  'スキル一致判定の集合演算版の実体。skill_hit_weights はこの合計。'
  'p_from_years=true なら skillYears のキーで照合し、満たしたスキルの最長月数を返す';

GRANT EXECUTE ON FUNCTION public.skill_hit_pairs(text, text[], jsonb, boolean) TO anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.skill_hit_pairs(text, text[], jsonb);

CREATE OR REPLACE FUNCTION public.skill_hit_weights(
  p_data_env        text,
  p_required_skills text[],
  p_skill_weights   jsonb DEFAULT NULL
)
RETURNS TABLE(candidate_id uuid, hit_w numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT p.candidate_id, SUM(p.w)
    FROM skill_hit_pairs(p_data_env, p_required_skills, p_skill_weights) p
   GROUP BY p.candidate_id
$$;

COMMENT ON FUNCTION public.skill_hit_weights(text, text[], jsonb) IS
  '必須スキルに対する候補者ごとの充足重み合計。1つも満たさない候補者は返さない。'
  '本体は skill_hit_pairs（2026-10-31 に組を返す関数へ移した）';

-- ============================================================
-- ③ 年数の判定
-- ============================================================

-- 年数を見る対象か。技術（言語・FW・ライブラリ・DB・DWH・クラウド・インフラ・OS・ツール・
-- デザイン・マーケ製品）だけ。工程（methodologies）・英語等（others）・資格は見ない。
-- skill_master に無い語（案件側の「クラウド上での開発経験」のような文）は見ない＝false。
-- 年数を照合する相手が無いので、見ると全員が「年数不明」になる
CREATE OR REPLACE FUNCTION public.skill_is_tech(p_skill text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT m.category NOT IN ('methodologies', 'others', 'certifications')
       FROM skill_master m
      WHERE lower(m.name) = skill_canon(p_skill)
      LIMIT 1),
    false)
$$;

COMMENT ON FUNCTION public.skill_is_tech(text) IS
  'スキル年数をマッチングで見る対象か（技術なら true。工程・英語・資格・マスタに無い語は false）';

-- 人材の skillYears（{"Java":96,...} 月数）に、必須スキル p_want を満たすスキルの年数が
-- p_min_months 以上あるか。満たすかどうかは skill_satisfies（スキル一致の定義）で見る。
-- "_totalProjectMonths" のような _ 始まりの内部キーは見ない
CREATE OR REPLACE FUNCTION public.skill_years_meets(p_years jsonb, p_want text, p_min_months numeric)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_each(CASE WHEN jsonb_typeof(p_years) = 'object' THEN p_years ELSE '{}'::jsonb END) e
     WHERE left(e.key, 1) <> '_'
       AND jsonb_typeof(e.value) = 'number'
       AND (e.value #>> '{}')::numeric > 0
       AND (e.value #>> '{}')::numeric >= COALESCE(p_min_months, 0)
       AND skill_satisfies(e.key, p_want)
  )
$$;

COMMENT ON FUNCTION public.skill_years_meets(jsonb, text, numeric) IS
  '人材の skillYears に、必須スキルを満たすスキルの年数が指定月数以上あるか（0 なら年数が取れているか）';

-- 案件が年数を書いた技術（raw_data.requiredSkillYears {"Java":[10]}）を全部満たすか。
-- 年数が取れていない人は満たさない（マスト）。年数が複数書かれていれば一番短いものを使う
-- （「Java 3年以上、うち設計1年」のような書き方で長い方を採ると厳しすぎる）
CREATE OR REPLACE FUNCTION public.skill_years_gate_ok(p_years jsonb, p_required_years jsonb)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM jsonb_each(CASE WHEN jsonb_typeof(p_required_years) = 'object' THEN p_required_years ELSE '{}'::jsonb END) r
     WHERE jsonb_typeof(r.value) = 'array'
       AND jsonb_array_length(r.value) > 0
       AND skill_is_tech(r.key)
       AND NOT skill_years_meets(
             p_years, r.key,
             12 * (SELECT min(x::numeric) FROM jsonb_array_elements_text(r.value) x WHERE x ~ '^[0-9.]+$'))
  )
$$;

COMMENT ON FUNCTION public.skill_years_gate_ok(jsonb, jsonb) IS
  '案件が年数を書いた技術をすべて満たすか（年数が取れていない人は満たさない）。'
  'fetch_candidates_for_project の足切り';

GRANT EXECUTE ON FUNCTION public.skill_is_tech(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skill_years_meets(jsonb, text, numeric) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skill_years_gate_ok(jsonb, jsonb) TO anon, authenticated, service_role;

-- match-batch（画面に出る点数）用。候補者バッチごとに「年数が取れていない技術の必須スキル」を返す。
-- 点を半分にするのは「満たしている かつ ここに出る」組だけ（満たしているかは match_skill_hits_batch）
-- p_years: 候補者ごとの skillYears の配列。例 '[{"Java":96},{}]'
CREATE OR REPLACE FUNCTION public.match_unverified_tech_batch(
  p_years jsonb,
  p_want  text[]
)
RETURNS TABLE(idx int, want text)
LANGUAGE sql STABLE
AS $$
  WITH w AS (SELECT DISTINCT w FROM unnest(COALESCE(p_want, ARRAY[]::text[])) w WHERE skill_is_tech(w))
  SELECT (c.ord - 1)::int, w.w
    FROM jsonb_array_elements(COALESCE(p_years, '[]'::jsonb)) WITH ORDINALITY AS c(sy, ord)
    CROSS JOIN w
   WHERE NOT skill_years_meets(c.sy, w.w, 0)
$$;

COMMENT ON FUNCTION public.match_unverified_tech_batch(jsonb, text[]) IS
  '候補者バッチ×必須スキルのうち、技術なのに年数が取れていない組を返す。match-batch のスキル点を半分にする根拠';

GRANT EXECUTE ON FUNCTION public.match_unverified_tech_batch(jsonb, text[]) TO anon, authenticated, service_role;
