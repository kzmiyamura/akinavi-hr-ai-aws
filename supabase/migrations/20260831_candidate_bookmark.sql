-- 人材のブックマーク（星）を追加する（2026-08-31）
--
-- チーム共有の1状態として candidates に列で持つ。別テーブルにしない理由:
--   ・人材は保持日数を過ぎると行ごと削除されるので、列なら一緒に消える（外部キー不要）
--   ・同一人物の再登録は既存行の UPDATE なので、星が残る（望ましい挙動）
--   ・認証が無くユーザーを識別できないため、個人ごとの管理には意味がない
-- 「★のみ表示」の絞り込み状態は端末ごと（localStorage）に持つ。DBには保存しない。
--
-- 【ビューの扱い】
-- candidates_lite には 6本の関数が依存している
-- （fetch_candidates_for_matching / fetch_candidates_for_project / filter_candidates /
--   search_candidates ×2 / search_candidates_for_matching）。
-- DROP VIEW ... CASCADE すると全部道連れで消え、人材一覧・検索・マッチングが止まる
-- （過去のマイグレーションで実際に消えて作り直している）。
-- 新しい列を**末尾に足す**なら CREATE OR REPLACE VIEW で置き換えられるので、
-- DROP せずに済ませる。列の順序と型を変えないこと。

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS bookmarked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN candidates.bookmarked IS
  'チーム共有のブックマーク（星）。人材の削除で一緒に消える。再登録では引き継がれる';

-- ★を付けた人だけを引くための部分インデックス（付いている人は少数の想定）
CREATE INDEX IF NOT EXISTS idx_candidates_bookmarked
  ON candidates (data_env, created_at DESC)
  WHERE bookmarked;

-- ビューに末尾追加（DROP しない = 依存する6関数は無傷）
CREATE OR REPLACE VIEW candidates_lite AS
SELECT
  id, name, email, phone, skills, experience_years, desired_rate,
  from_company, resume_url, drive_url, box_url, box_status,
  created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
  (raw_profile - 'text' - 'parsedGrid') AS raw_profile,
  bookmarked
FROM candidates;

GRANT SELECT ON candidates_lite TO anon, authenticated;

-- ⚠ ここから下は必須。ビューに列を足しただけでは本番が壊れる（2026-08-31 に実際に壊した）。
--
-- search_candidates と filter_candidates は PL/pgSQL で、列を**文字列として明示列挙**した
-- lite_select 定数を EXECUTE している。ビューが21列になると
--   ERROR: structure of query does not match function result type
--   DETAIL: Number of returned columns (20) does not match expected column count (21)
-- で実行時に落ちる。人材検索・絞り込みが止まる。
--
-- しかも CREATE OR REPLACE VIEW では列を減らせない（cannot drop columns from view）ため、
-- ビューだけ元に戻すことができない。DROP VIEW ... CASCADE すると依存6関数が道連れになる。
-- つまり「ビューに足したら、この2関数も同時に直す」以外に安全な道が無い。
--
-- 返り値の型が RETURNS SETOF candidates_lite でも、本体が SELECT * とは限らない。
-- 列を足すときは必ず関数の**本体**まで確認すること。
--
-- 以下は pg_get_functiondef で取り出した現行定義に bookmarked を1行足したもの。
-- 手写しではないので、既存のロジックとのズレは無い。

CREATE OR REPLACE FUNCTION public.search_candidates(p_data_env text, p_keywords text[], p_mode text DEFAULT 'AND'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_fields text[] DEFAULT ARRAY['name'::text, 'skills'::text, 'prefecture'::text])
 RETURNS SETOF candidates_lite
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  kw          text;
  pat         text;
  field       text;
  field_conds text[] := '{}';
  kw_cond     text;
  kw_conds    text[] := '{}';
  search_expr text;
  q           text;
  lite_select constant text :=
    'id, name, email, phone, skills, experience_years, desired_rate,
     from_company, resume_url, drive_url, box_url, box_status,
     created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
     (raw_profile - ''text'' - ''parsedGrid'') AS raw_profile,
     bookmarked';
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    pat := '%' || kw || '%';
    field_conds := '{}';
    FOREACH field IN ARRAY p_fields LOOP
      IF field = 'name' THEN
        field_conds := field_conds || format('name ILIKE %L', pat);
      ELSIF field = 'skills' THEN
        field_conds := field_conds || format('(skills::text ILIKE %L OR COALESCE((raw_profile->''skillsByCategory'')::text,'''') ILIKE %L)', pat, pat);
      ELSIF field = 'prefecture' THEN
        field_conds := field_conds || format('COALESCE(raw_profile->>''prefecture'','''') ILIKE %L', pat);
      ELSIF field = 'body' THEN
        field_conds := field_conds || format('COALESCE(raw_profile->>''text'','''') ILIKE %L', pat);
      END IF;
    END LOOP;
    IF cardinality(field_conds) = 0 THEN CONTINUE; END IF;
    kw_cond := '(' || array_to_string(field_conds, ' OR ') || ')';
    kw_conds := kw_conds || kw_cond;
  END LOOP;

  IF cardinality(kw_conds) = 0 THEN
    RETURN QUERY EXECUTE format(
      'SELECT %s FROM candidates WHERE data_env = %L AND merged_into IS NULL ORDER BY updated_at DESC LIMIT %s OFFSET %s',
      lite_select, p_data_env, p_limit, p_offset
    );
    RETURN;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(kw_conds, ' AND ');
  ELSE
    search_expr := array_to_string(kw_conds, ' OR ');
  END IF;

  q := format(
    'SELECT %s FROM candidates WHERE data_env = %L AND merged_into IS NULL AND (%s) ORDER BY updated_at DESC LIMIT %s OFFSET %s',
    lite_select, p_data_env, search_expr, p_limit, p_offset
  );
  RETURN QUERY EXECUTE q;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.filter_candidates(p_data_env text, p_name text DEFAULT NULL::text, p_skills text[] DEFAULT NULL::text[], p_prefecture text DEFAULT NULL::text, p_exp_min integer DEFAULT NULL::integer, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS SETOF candidates_lite
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  skill      text;
  conditions text[] := ARRAY[
    format('data_env = %L', p_data_env),
    'merged_into IS NULL',
    'duplicate_flag = false'
  ];
  lite_select constant text :=
    'id, name, email, phone, skills, experience_years, desired_rate,
     from_company, resume_url, drive_url, box_url, box_status,
     created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
     (raw_profile - ''text'' - ''parsedGrid'') AS raw_profile,
     bookmarked';
BEGIN
  -- 氏名 部分一致
  IF p_name IS NOT NULL AND p_name <> '' THEN
    conditions := conditions || format('name ILIKE %L', '%' || p_name || '%');
  END IF;

  -- 都道府県 完全一致（ドロップダウン選択なので表記ゆれなし）
  IF p_prefecture IS NOT NULL AND p_prefecture <> '' THEN
    conditions := conditions || format(
      'raw_profile->>''prefecture'' = %L', p_prefecture
    );
  END IF;

  -- 経験年数 下限
  IF p_exp_min IS NOT NULL THEN
    conditions := conditions || format('COALESCE(experience_years, 0) >= %s', p_exp_min);
  END IF;

  -- スキル: 各スキルを AND で skills 配列テキストに部分一致
  IF p_skills IS NOT NULL THEN
    FOREACH skill IN ARRAY p_skills LOOP
      IF skill <> '' THEN
        conditions := conditions || format(
          '(skills::text ILIKE %L OR COALESCE((raw_profile->>''skillsByCategory''),'''') ILIKE %L)',
          '%' || skill || '%', '%' || skill || '%'
        );
      END IF;
    END LOOP;
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT %s FROM candidates WHERE %s ORDER BY updated_at DESC LIMIT %s OFFSET %s',
    lite_select,
    array_to_string(conditions, ' AND '),
    p_limit,
    p_offset
  );
END;
$function$
;

-- search_candidates_for_matching に「★のみ」の絞り込みを足す（2026-08-31）
--
-- マッチング画面の人材モードは50件ずつしか引かないので、手元で絞ると
-- 「★を付けた人が一覧に出てこない」ことが起きる。サーバー側で絞る。
--
-- 引数が増えるので CREATE OR REPLACE では上書きできない（別オーバーロードになり
-- PostgREST が曖昧になる）。DROP してから作り直す。本体は SELECT * のままなので
-- ビューの列追加には追従する。
DROP FUNCTION IF EXISTS search_candidates_for_matching(text, text[], text, integer, integer);

CREATE FUNCTION public.search_candidates_for_matching(
  p_data_env text,
  p_keywords text[] DEFAULT NULL::text[],
  p_mode text DEFAULT 'AND'::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_bookmarked_only boolean DEFAULT false
)
 RETURNS SETOF candidates_lite
 LANGUAGE sql
 STABLE
AS $function$
  SELECT *
  FROM candidates_lite c
  WHERE c.data_env       = p_data_env
    AND c.merged_into    IS NULL
    AND c.duplicate_flag = false
    AND (NOT p_bookmarked_only OR c.bookmarked)
    AND (
      p_keywords IS NULL
      OR cardinality(p_keywords) = 0
      OR (
        CASE WHEN upper(p_mode) = 'OR'
          THEN EXISTS (
            SELECT 1 FROM unnest(p_keywords) kw
            WHERE c.name ILIKE '%' || kw || '%'
               OR COALESCE(c.email, '') ILIKE '%' || kw || '%'
               OR c.skills::text ILIKE '%' || kw || '%'
          )
          ELSE NOT EXISTS (
            SELECT 1 FROM unnest(p_keywords) kw
            WHERE NOT (
              c.name ILIKE '%' || kw || '%'
              OR COALESCE(c.email, '') ILIKE '%' || kw || '%'
              OR c.skills::text ILIKE '%' || kw || '%'
            )
          )
        END
      )
    )
  ORDER BY
    c.created_at DESC,
    COALESCE(c.experience_years, 0) DESC,
    c.id
  LIMIT p_limit OFFSET p_offset;
$function$;
-- 人材マップの一覧にも★を出せるよう bookmarked を返す（2026-08-31）
-- アーカイブ済み（candidates_archive_light）は列を持たないので false を返す。
-- 開くこともできない行なので星も出さない。
DROP FUNCTION IF EXISTS candidates_by_prefecture(text, text, text, int, text);
CREATE OR REPLACE FUNCTION candidates_by_prefecture(
  p_data_env   text,
  p_prefecture text,
  p_skill      text DEFAULT NULL,
  p_limit      int  DEFAULT 10,
  p_period     text DEFAULT '7d'
)
RETURNS TABLE(id uuid, name text, subject text, created_at timestamptz,
              is_archived boolean, bookmarked boolean)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.name, c.raw_profile->>'subject' AS subject, c.created_at,
         false AS is_archived, c.bookmarked
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

  SELECT a.id, a.name, a.subject, a.created_at, true AS is_archived, false AS bookmarked
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
