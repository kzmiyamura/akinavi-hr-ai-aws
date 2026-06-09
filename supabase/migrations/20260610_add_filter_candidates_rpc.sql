-- 個別フィールドでフィルタリングする RPC
-- 検索ボックス + フィールドトグル方式を廃止し、各フィールドを専用引数で受け取るシンプルな設計
--
-- 引数:
--   p_name       : 氏名（部分一致・NULL なら条件なし）
--   p_skills     : スキル配列（各要素を AND で skills 列に部分一致・NULL or 空配列なら条件なし）
--   p_prefecture : 都道府県（完全一致・NULL なら条件なし）
--   p_exp_min    : 経験年数の下限（以上・NULL なら条件なし）
--   p_limit      : 取得件数（デフォルト 100）
--   p_offset     : オフセット（デフォルト 0）

CREATE OR REPLACE FUNCTION filter_candidates(
  p_data_env   text,
  p_name       text    DEFAULT NULL,
  p_skills     text[]  DEFAULT NULL,
  p_prefecture text    DEFAULT NULL,
  p_exp_min    int     DEFAULT NULL,
  p_limit      int     DEFAULT 100,
  p_offset     int     DEFAULT 0
)
RETURNS SETOF candidates_lite
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
     (raw_profile - ''text'' - ''parsedGrid'') AS raw_profile';
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
$$;

-- 件数取得版
CREATE OR REPLACE FUNCTION count_filter_candidates(
  p_data_env   text,
  p_name       text    DEFAULT NULL,
  p_skills     text[]  DEFAULT NULL,
  p_prefecture text    DEFAULT NULL,
  p_exp_min    int     DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
    conditions := conditions || format('name ILIKE %L', '%' || p_name || '%');
  END IF;
  IF p_prefecture IS NOT NULL AND p_prefecture <> '' THEN
    conditions := conditions || format('raw_profile->>''prefecture'' = %L', p_prefecture);
  END IF;
  IF p_exp_min IS NOT NULL THEN
    conditions := conditions || format('COALESCE(experience_years, 0) >= %s', p_exp_min);
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

  EXECUTE format(
    'SELECT COUNT(*) FROM candidates WHERE %s',
    array_to_string(conditions, ' AND ')
  ) INTO result;
  RETURN result;
END;
$$;
