-- 人材の通し番号 ②ビューと関数（2026-10-08）
--
-- ⚠ 先に 20261008_candidate_no.sql（列と連番）を当てること。列が無いと最初の CREATE VIEW で落ちる。
--
-- ■ ここを飛ばすと本番が止まる
--   `candidates_lite` には6本の関数が依存しており、DROP すると全部道連れになる。
--   **末尾に足す**なら CREATE OR REPLACE VIEW で置き換えられる。
--   ただし列を文字列で手書き列挙している関数は、ビューが22列になると
--     ERROR: structure of query does not match function result type
--   で実行時に落ちる。prod を実測して対象を特定した（2026-10-08）:
--     列を手書き … filter_candidates / search_candidates(p_fields 版)  ← この2本だけ直す
--     SELECT *   … fetch_candidates_for_matching / fetch_candidates_for_project /
--                  search_candidates(p_scope 版) / search_candidates_for_matching  ← 無傷
--   2関数は `pg_get_functiondef` で取り出した現行定義に1行足したもの。手写しではない
--   （最初に手写しして並び順と条件を取り違えたので、差分を機械的に照合して直した）。
--
-- ■ 途中で失敗したら
--   ビューだけ22列になって関数が20列を返す状態が一番まずい（人材検索・絞り込みが止まる）。
--   CREATE OR REPLACE VIEW では列を減らせないので、その場合は下の3関数を
--   もう一度流して合わせる（このファイルを再実行すれば足りる）。

-- ── ② ビューに末尾追加（DROP しない = 依存6関数は無傷）───────────────────
-- 列順と raw_profile の strip 一覧は prod の現行定義（pg_get_viewdef）と同一。変えない。
CREATE OR REPLACE VIEW candidates_lite AS
SELECT
  id, name, email, phone, skills, experience_years, desired_rate,
  from_company, resume_url, drive_url, box_url, box_status,
  created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
  (raw_profile
     - 'text'
     - 'parsedGrid'
     - 'jsonRows'
     - 'attachmentText'
     - 'pipeline_trace'
     - '_roleScores'
     - '_industryScores'
     - 'allParsedAttachmentLabels'
     - 'hfDetectedMissingSkills'
  ) AS raw_profile,
  bookmarked,
  candidate_no
FROM candidates;

GRANT SELECT ON candidates_lite TO anon, authenticated;

-- ── ③ 列を手書き列挙している2関数 ───────────────────────────────────────
-- filter_candidates: lite_select に candidate_no を足し、
--                    さらに p_name に番号が来たら番号で引く（氏名欄をそのまま使えるように）
CREATE OR REPLACE FUNCTION public.filter_candidates(p_data_env text, p_name text DEFAULT NULL::text, p_skills text[] DEFAULT NULL::text[], p_prefecture text DEFAULT NULL::text, p_exp_min integer DEFAULT NULL::integer, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_rate_max integer DEFAULT NULL::integer, p_rate_min integer DEFAULT NULL::integer, p_commercial_flow text DEFAULT NULL::text, p_employment_type text DEFAULT NULL::text, p_available_by date DEFAULT NULL::date, p_work_style text DEFAULT NULL::text, p_haken_ok boolean DEFAULT NULL::boolean, p_has_resume boolean DEFAULT NULL::boolean)
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
     bookmarked, candidate_no';
BEGIN
  -- 氏名欄に人材番号（`123` / `AK-123` / `ak 000123`）が入ってきたら番号で引く。
  -- 営業は同じ欄に名前も番号も入れるので、入力の形で分岐させる方が間違えない。
  -- 全角数字・全角ハイフンも受ける（メモからの貼り付けで混ざる）。
  IF p_name IS NOT NULL AND p_name <> '' THEN
    IF translate(p_name, '０１２３４５６７８９－', '0123456789-')
         ~ '^\s*([Aa][Kk])?\s*[-]?\s*[0-9]+\s*$' THEN
      conditions := conditions || format(
        'candidate_no = %s',
        (regexp_replace(translate(p_name, '０１２３４５６７８９－', '0123456789-'),
                        '[^0-9]', '', 'g'))::bigint);
    ELSE
      conditions := conditions || format('name ILIKE %L', '%' || p_name || '%');
    END IF;
  END IF;
  IF p_prefecture IS NOT NULL AND p_prefecture <> '' THEN
    conditions := conditions || format('raw_profile->>''prefecture'' = %L', p_prefecture);
  END IF;
  IF p_exp_min IS NOT NULL THEN
    conditions := conditions || format('COALESCE(experience_years, 0) >= %s', p_exp_min);
  END IF;
  IF p_rate_max IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_rate_man(desired_rate) IS NULL OR parse_rate_man(desired_rate) <= %s)', p_rate_max);
  END IF;
  IF p_rate_min IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_rate_man(desired_rate) IS NULL OR parse_rate_man(desired_rate) >= %s)', p_rate_min);
  END IF;
  IF p_commercial_flow IS NOT NULL AND p_commercial_flow <> '' THEN
    conditions := conditions || format('raw_profile->>''commercialFlow'' = %L', p_commercial_flow);
  END IF;
  IF p_employment_type IS NOT NULL AND p_employment_type <> '' THEN
    conditions := conditions || format('raw_profile->>''employmentType'' = %L', p_employment_type);
  END IF;
  IF p_available_by IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_available_from(raw_profile->>''availableFrom'') IS NULL'
      ' OR parse_available_from(raw_profile->>''availableFrom'') <= %L)', p_available_by);
  END IF;
  IF p_work_style IS NOT NULL AND p_work_style <> '' THEN
    conditions := conditions || format('raw_profile->>''workStyleTag'' = %L', p_work_style);
  END IF;
  IF p_haken_ok IS NOT NULL THEN
    conditions := conditions || format(
      '(raw_profile->>''hakenOk'')::boolean = %L', p_haken_ok);
  END IF;
  -- 経歴書の有無。Box・Drive 運用の人材を落とさないよう3つの列を見る
  IF p_has_resume IS TRUE THEN
    conditions := conditions ||
      '(resume_url IS NOT NULL OR box_url IS NOT NULL OR drive_url IS NOT NULL)'::text;
  ELSIF p_has_resume IS FALSE THEN
    conditions := conditions ||
      '(resume_url IS NULL AND box_url IS NULL AND drive_url IS NULL)'::text;
  END IF;
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
    lite_select, array_to_string(conditions, ' AND '), p_limit, p_offset);
END;
$function$;

-- count_filter_candidates: 一覧と**同じ条件**にする。
-- 片方だけ直すと「該当3件」と出ているのに一覧に30件並ぶ。
CREATE OR REPLACE FUNCTION public.count_filter_candidates(p_data_env text, p_name text DEFAULT NULL::text, p_skills text[] DEFAULT NULL::text[], p_prefecture text DEFAULT NULL::text, p_exp_min integer DEFAULT NULL::integer, p_rate_max integer DEFAULT NULL::integer, p_rate_min integer DEFAULT NULL::integer, p_commercial_flow text DEFAULT NULL::text, p_employment_type text DEFAULT NULL::text, p_available_by date DEFAULT NULL::date, p_work_style text DEFAULT NULL::text, p_haken_ok boolean DEFAULT NULL::boolean, p_has_resume boolean DEFAULT NULL::boolean)
 RETURNS bigint
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
  result bigint;
BEGIN
  IF p_name IS NOT NULL AND p_name <> '' THEN
    IF translate(p_name, '０１２３４５６７８９－', '0123456789-')
         ~ '^\s*([Aa][Kk])?\s*[-]?\s*[0-9]+\s*$' THEN
      conditions := conditions || format(
        'candidate_no = %s',
        (regexp_replace(translate(p_name, '０１２３４５６７８９－', '0123456789-'),
                        '[^0-9]', '', 'g'))::bigint);
    ELSE
      conditions := conditions || format('name ILIKE %L', '%' || p_name || '%');
    END IF;
  END IF;
  IF p_prefecture IS NOT NULL AND p_prefecture <> '' THEN
    conditions := conditions || format('raw_profile->>''prefecture'' = %L', p_prefecture);
  END IF;
  IF p_exp_min IS NOT NULL THEN
    conditions := conditions || format('COALESCE(experience_years, 0) >= %s', p_exp_min);
  END IF;
  IF p_rate_max IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_rate_man(desired_rate) IS NULL OR parse_rate_man(desired_rate) <= %s)', p_rate_max);
  END IF;
  IF p_rate_min IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_rate_man(desired_rate) IS NULL OR parse_rate_man(desired_rate) >= %s)', p_rate_min);
  END IF;
  IF p_commercial_flow IS NOT NULL AND p_commercial_flow <> '' THEN
    conditions := conditions || format('raw_profile->>''commercialFlow'' = %L', p_commercial_flow);
  END IF;
  IF p_employment_type IS NOT NULL AND p_employment_type <> '' THEN
    conditions := conditions || format('raw_profile->>''employmentType'' = %L', p_employment_type);
  END IF;
  IF p_available_by IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_available_from(raw_profile->>''availableFrom'') IS NULL'
      ' OR parse_available_from(raw_profile->>''availableFrom'') <= %L)', p_available_by);
  END IF;
  IF p_work_style IS NOT NULL AND p_work_style <> '' THEN
    conditions := conditions || format('raw_profile->>''workStyleTag'' = %L', p_work_style);
  END IF;
  IF p_haken_ok IS NOT NULL THEN
    conditions := conditions || format('(raw_profile->>''hakenOk'')::boolean = %L', p_haken_ok);
  END IF;
  IF p_has_resume IS TRUE THEN
    conditions := conditions ||
      '(resume_url IS NOT NULL OR box_url IS NOT NULL OR drive_url IS NOT NULL)'::text;
  ELSIF p_has_resume IS FALSE THEN
    conditions := conditions ||
      '(resume_url IS NULL AND box_url IS NULL AND drive_url IS NULL)'::text;
  END IF;
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

  EXECUTE format('SELECT COUNT(*) FROM candidates WHERE %s',
    array_to_string(conditions, ' AND ')) INTO result;
  RETURN result;
END;
$function$;

-- search_candidates(p_fields 版): lite_select に candidate_no を足すだけ（ロジックは触らない）
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
     bookmarked, candidate_no';
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
$function$;

GRANT EXECUTE ON FUNCTION public.filter_candidates(
  text, text, text[], text, integer, integer, integer, integer, integer,
  text, text, date, text, boolean, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_filter_candidates(
  text, text, text[], text, integer, integer, integer, text, text, date,
  text, boolean, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_candidates(
  text, text[], text, integer, integer, text[]) TO anon, authenticated;
