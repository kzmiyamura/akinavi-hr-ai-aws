-- 人材全文検索 RPC（AND/OR モード、ページネーション付き）
CREATE OR REPLACE FUNCTION search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode text DEFAULT 'AND',
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS SETOF candidates
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw text;
  cond text;
  conditions text[] := '{}';
  search_expr text;
  q text;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    cond := format(
      '(name ILIKE %L OR array_to_string(skills, '' '') ILIKE %L OR raw_profile::text ILIKE %L)',
      '%' || kw || '%',
      '%' || kw || '%',
      '%' || kw || '%'
    );
    conditions := conditions || cond;
  END LOOP;

  IF cardinality(conditions) = 0 THEN
    RETURN QUERY
      SELECT * FROM candidates
      WHERE data_env = p_data_env AND merged_into IS NULL
      ORDER BY updated_at DESC
      LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(conditions, ' AND ');
  ELSE
    search_expr := array_to_string(conditions, ' OR ');
  END IF;

  q := format(
    'SELECT * FROM candidates WHERE data_env = %L AND merged_into IS NULL AND (%s) ORDER BY updated_at DESC LIMIT %s OFFSET %s',
    p_data_env, search_expr, p_limit, p_offset
  );

  RETURN QUERY EXECUTE q;
END;
$$;

-- 人材検索件数 RPC
CREATE OR REPLACE FUNCTION count_search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode text DEFAULT 'AND'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw text;
  cond text;
  conditions text[] := '{}';
  search_expr text;
  q text;
  result bigint;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    cond := format(
      '(name ILIKE %L OR array_to_string(skills, '' '') ILIKE %L OR raw_profile::text ILIKE %L)',
      '%' || kw || '%',
      '%' || kw || '%',
      '%' || kw || '%'
    );
    conditions := conditions || cond;
  END LOOP;

  IF cardinality(conditions) = 0 THEN
    SELECT COUNT(*) INTO result FROM candidates WHERE data_env = p_data_env AND merged_into IS NULL;
    RETURN result;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(conditions, ' AND ');
  ELSE
    search_expr := array_to_string(conditions, ' OR ');
  END IF;

  q := format(
    'SELECT COUNT(*) FROM candidates WHERE data_env = %L AND merged_into IS NULL AND (%s)',
    p_data_env, search_expr
  );

  EXECUTE q INTO result;
  RETURN result;
END;
$$;

-- 案件全文検索 RPC（AND/OR モード、ページネーション付き）
CREATE OR REPLACE FUNCTION search_projects(
  p_data_env text,
  p_keywords text[],
  p_mode text DEFAULT 'AND',
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS SETOF projects
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw text;
  cond text;
  conditions text[] := '{}';
  search_expr text;
  q text;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    cond := format(
      '(title ILIKE %L OR array_to_string(required_skills, '' '') ILIKE %L OR raw_data::text ILIKE %L)',
      '%' || kw || '%',
      '%' || kw || '%',
      '%' || kw || '%'
    );
    conditions := conditions || cond;
  END LOOP;

  IF cardinality(conditions) = 0 THEN
    RETURN QUERY
      SELECT * FROM projects
      WHERE data_env = p_data_env
      ORDER BY created_at DESC
      LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(conditions, ' AND ');
  ELSE
    search_expr := array_to_string(conditions, ' OR ');
  END IF;

  q := format(
    'SELECT * FROM projects WHERE data_env = %L AND (%s) ORDER BY created_at DESC LIMIT %s OFFSET %s',
    p_data_env, search_expr, p_limit, p_offset
  );

  RETURN QUERY EXECUTE q;
END;
$$;

-- 案件検索件数 RPC
CREATE OR REPLACE FUNCTION count_search_projects(
  p_data_env text,
  p_keywords text[],
  p_mode text DEFAULT 'AND'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw text;
  cond text;
  conditions text[] := '{}';
  search_expr text;
  q text;
  result bigint;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    cond := format(
      '(title ILIKE %L OR array_to_string(required_skills, '' '') ILIKE %L OR raw_data::text ILIKE %L)',
      '%' || kw || '%',
      '%' || kw || '%',
      '%' || kw || '%'
    );
    conditions := conditions || cond;
  END LOOP;

  IF cardinality(conditions) = 0 THEN
    SELECT COUNT(*) INTO result FROM projects WHERE data_env = p_data_env;
    RETURN result;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(conditions, ' AND ');
  ELSE
    search_expr := array_to_string(conditions, ' OR ');
  END IF;

  q := format(
    'SELECT COUNT(*) FROM projects WHERE data_env = %L AND (%s)',
    p_data_env, search_expr
  );

  EXECUTE q INTO result;
  RETURN result;
END;
$$;
