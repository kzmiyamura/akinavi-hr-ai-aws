-- search_candidates / count_search_candidates に p_scope パラメータを追加
-- p_scope:
--   'tags'  … 名前・スキル・都道府県・最寄駅・役割・業界・サマリ・エージェントコメント等、
--             構造化フィールドのみ検索（メール本文 raw_profile.text は除外）
--   'body'  … raw_profile.text（メール本文）のみ検索
--   'all'   … 名前・スキル・raw_profile 全体（既定・従来動作）

CREATE OR REPLACE FUNCTION search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode text DEFAULT 'AND',
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0,
  p_scope text DEFAULT 'all'
)
RETURNS SETOF candidates
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw text;
  pat text;
  cond text;
  conditions text[] := '{}';
  search_expr text;
  q text;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    pat := '%' || kw || '%';
    IF p_scope = 'tags' THEN
      -- 構造化フィールドのみ（メール本文除外）
      cond := format(
        '(name ILIKE %L
          OR skills::text ILIKE %L
          OR COALESCE(desired_rate,'''') ILIKE %L
          OR COALESCE(from_company,'''') ILIKE %L
          OR COALESCE(raw_profile->>''prefecture'','''') ILIKE %L
          OR COALESCE(raw_profile->>''nearestStation'','''') ILIKE %L
          OR COALESCE(raw_profile->>''currentWorkLocation'','''') ILIKE %L
          OR COALESCE(raw_profile->>''summary'','''') ILIKE %L
          OR COALESCE(raw_profile->>''agentComment'','''') ILIKE %L
          OR COALESCE((raw_profile->''skillsByCategory'')::text,'''') ILIKE %L
          OR COALESCE((raw_profile->''roles'')::text,'''') ILIKE %L
          OR COALESCE((raw_profile->''industries'')::text,'''') ILIKE %L)',
        pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat
      );
    ELSIF p_scope = 'body' THEN
      -- メール本文のみ
      cond := format(
        'COALESCE(raw_profile->>''text'','''') ILIKE %L',
        pat
      );
    ELSE
      -- 'all'（従来動作）
      cond := format(
        '(name ILIKE %L OR skills::text ILIKE %L OR raw_profile::text ILIKE %L)',
        pat, pat, pat
      );
    END IF;
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

CREATE OR REPLACE FUNCTION count_search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode text DEFAULT 'AND',
  p_scope text DEFAULT 'all'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw text;
  pat text;
  cond text;
  conditions text[] := '{}';
  search_expr text;
  q text;
  result bigint;
BEGIN
  FOREACH kw IN ARRAY p_keywords LOOP
    pat := '%' || kw || '%';
    IF p_scope = 'tags' THEN
      cond := format(
        '(name ILIKE %L
          OR skills::text ILIKE %L
          OR COALESCE(desired_rate,'''') ILIKE %L
          OR COALESCE(from_company,'''') ILIKE %L
          OR COALESCE(raw_profile->>''prefecture'','''') ILIKE %L
          OR COALESCE(raw_profile->>''nearestStation'','''') ILIKE %L
          OR COALESCE(raw_profile->>''currentWorkLocation'','''') ILIKE %L
          OR COALESCE(raw_profile->>''summary'','''') ILIKE %L
          OR COALESCE(raw_profile->>''agentComment'','''') ILIKE %L
          OR COALESCE((raw_profile->''skillsByCategory'')::text,'''') ILIKE %L
          OR COALESCE((raw_profile->''roles'')::text,'''') ILIKE %L
          OR COALESCE((raw_profile->''industries'')::text,'''') ILIKE %L)',
        pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat
      );
    ELSIF p_scope = 'body' THEN
      cond := format(
        'COALESCE(raw_profile->>''text'','''') ILIKE %L',
        pat
      );
    ELSE
      cond := format(
        '(name ILIKE %L OR skills::text ILIKE %L OR raw_profile::text ILIKE %L)',
        pat, pat, pat
      );
    END IF;
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
