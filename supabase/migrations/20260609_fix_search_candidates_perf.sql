-- search_candidates のパフォーマンス修正
-- candidates_lite ビュー経由にするとインデックスが効かずタイムアウトが発生したため、
-- WHERE 句は candidates テーブル直接（GIN インデックス利用）、
-- SELECT 時のみ raw_profile から text/parsedGrid を除去する方式に変更する。

DROP FUNCTION IF EXISTS search_candidates(text, text[], text, int, int, text);

CREATE FUNCTION search_candidates(
  p_data_env text,
  p_keywords text[],
  p_mode     text DEFAULT 'AND',
  p_limit    int  DEFAULT 100,
  p_offset   int  DEFAULT 0,
  p_scope    text DEFAULT 'all'
)
RETURNS SETOF candidates_lite
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  kw         text;
  pat        text;
  cond       text;
  conditions text[] := '{}';
  search_expr text;
  q          text;
  -- lite 形式の SELECT 列リスト（candidates テーブルから text/parsedGrid を除外）
  lite_select constant text :=
    'id, name, email, phone, skills, experience_years, desired_rate,
     from_company, resume_url, drive_url, box_url, box_status,
     created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
     (raw_profile - ''text'' - ''parsedGrid'') AS raw_profile';
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
    RETURN QUERY EXECUTE format(
      'SELECT %s FROM candidates WHERE data_env = %L AND merged_into IS NULL ORDER BY updated_at DESC LIMIT %s OFFSET %s',
      lite_select, p_data_env, p_limit, p_offset
    );
    RETURN;
  END IF;

  IF p_mode = 'AND' THEN
    search_expr := array_to_string(conditions, ' AND ');
  ELSE
    search_expr := array_to_string(conditions, ' OR ');
  END IF;

  -- WHERE は candidates テーブル直接（インデックス利用）、SELECT 時のみ text/parsedGrid 除外
  q := format(
    'SELECT %s FROM candidates WHERE data_env = %L AND merged_into IS NULL AND (%s) ORDER BY updated_at DESC LIMIT %s OFFSET %s',
    lite_select, p_data_env, search_expr, p_limit, p_offset
  );

  RETURN QUERY EXECUTE q;
END;
$$;
