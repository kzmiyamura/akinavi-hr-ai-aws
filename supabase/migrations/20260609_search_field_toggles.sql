-- search_candidates / count_search_candidates を p_scope → p_fields に変更
-- p_fields: 検索対象フィールド配列 (name / skills / prefecture / body)
-- デフォルト: ['name','skills','prefecture']（本文は遅いため除外）

DROP FUNCTION IF EXISTS search_candidates(text, text[], text, int, int, text);
DROP FUNCTION IF EXISTS count_search_candidates(text, text[], text, text);

CREATE OR REPLACE FUNCTION search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode     text    DEFAULT 'AND',
  p_limit    int     DEFAULT 100,
  p_offset   int     DEFAULT 0,
  p_fields   text[]  DEFAULT ARRAY['name','skills','prefecture']
)
RETURNS SETOF candidates_lite
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
     (raw_profile - ''text'' - ''parsedGrid'') AS raw_profile';
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
$$;

CREATE OR REPLACE FUNCTION count_search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode     text   DEFAULT 'AND',
  p_fields   text[] DEFAULT ARRAY['name','skills','prefecture']
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw          text;
  pat         text;
  field       text;
  field_conds text[] := '{}';
  kw_cond     text;
  kw_conds    text[] := '{}';
  search_expr text;
  q           text;
  result      bigint;
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
    SELECT COUNT(*) INTO result FROM candidates WHERE data_env = p_data_env AND merged_into IS NULL;
    RETURN result;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(kw_conds, ' AND ');
  ELSE
    search_expr := array_to_string(kw_conds, ' OR ');
  END IF;

  q := format(
    'SELECT COUNT(*) FROM candidates WHERE data_env = %L AND merged_into IS NULL AND (%s)',
    p_data_env, search_expr
  );
  EXECUTE q INTO result;
  RETURN result;
END;
$$;
