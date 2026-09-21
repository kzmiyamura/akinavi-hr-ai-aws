-- ============================================================================
-- 人材の絞り込みに「取引条件」を足す（単価・商流・雇用形態）
-- ============================================================================
-- filter_candidates は 氏名 / スキル / 都道府県 / 経験年数下限 の4つしか見ていなかった。
-- **データは全部持っているのに絞れない**状態で、競合（Qoala）の
-- 「取引条件での絞り込み検索」に相当する機能が丸ごと無かった（2026-09-21 比較）。
--
-- 単価は「55～60万」「75万円」「６０万」のような自由記述。
-- 数値化してから比較する。全角数字が実データにあるので translate で半角に寄せること
-- （agent_company_stats ビューで 22P02 を踏んだのと同じ落とし穴）。
-- 範囲表記は**下限**を採る（「55～60万」で 60万以下を探したら出てくるべき）。
-- ============================================================================

/**
 * 希望単価の自由記述から「万円」の数値（下限）を取り出す。取れなければ NULL。
 *
 * ⚠ 「55～60万」は**片方にしか「万」が付かない**。素直に `([0-9]{2,3})万` で拾うと
 *    60 しか取れず、範囲の上限を下限として扱ってしまう（最初これを踏んだ）。
 *    先に範囲表記を「55万 60万」へ展開してから拾う。
 *    全角数字（「６０万」）も実データにあるので translate で半角に寄せる。
 */
CREATE OR REPLACE FUNCTION public.parse_rate_man(src text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT min(m[1]::numeric)
  FROM regexp_matches(
         regexp_replace(
           translate(coalesce(src, ''), '０１２３４５６７８９～－', '0123456789~-'),
           '([0-9]{2,3})[ 　]*[~〜ー−-][ 　]*([0-9]{2,3})[ 　]*万', '\1万 \2万', 'g'),
         '([0-9]{2,3})[ 　]*万', 'g') AS m
  WHERE m[1]::numeric BETWEEN 20 AND 300;
$$;

COMMENT ON FUNCTION public.parse_rate_man(text) IS
  '希望単価の自由記述（「55～60万」等）から万円の数値を取り出す。範囲は下限。全角数字にも対応';

-- ⚠ 引数を足した新しい定義は**別の関数**として登録される（オーバーロード）。
--    既定値があるので7引数の呼び出しが両方に一致し、
--    「function filter_candidates(...) is not unique」で落ちる。
--    古い定義を先に落とすこと。
DROP FUNCTION IF EXISTS public.filter_candidates(text, text, text[], text, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.filter_candidates(
  p_data_env        text,
  p_name            text    DEFAULT NULL,
  p_skills          text[]  DEFAULT NULL,
  p_prefecture      text    DEFAULT NULL,
  p_exp_min         integer DEFAULT NULL,
  p_limit           integer DEFAULT 100,
  p_offset          integer DEFAULT 0,
  -- ここから2026-09-21 追加。既存の呼び出しを壊さないよう末尾に足す
  p_rate_max        integer DEFAULT NULL,   -- この単価以下（万円）
  p_rate_min        integer DEFAULT NULL,   -- この単価以上（万円）
  p_commercial_flow text    DEFAULT NULL,   -- '自社' / '1社先' 等。完全一致
  p_employment_type text    DEFAULT NULL    -- '正社員' / 'フリーランス' 等。完全一致
)
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

  -- 希望単価（万円）。**単価が読み取れない人は除外しない**。
  -- 自由記述で書かれていて数値化できない人が一定数いるため、
  -- 絞り込んだ瞬間にその人たちが全員消えると取りこぼしになる。
  -- 「条件に合う」か「そもそも単価が分からない」を通す
  IF p_rate_max IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_rate_man(desired_rate) IS NULL OR parse_rate_man(desired_rate) <= %s)', p_rate_max);
  END IF;
  IF p_rate_min IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_rate_man(desired_rate) IS NULL OR parse_rate_man(desired_rate) >= %s)', p_rate_min);
  END IF;

  -- 商流（自社 / N社先）。ここは読み取れない人を通さない。
  -- 「自社だけ見たい」は派遣の適法性・中抜きの話なので、曖昧なものを混ぜると意味が無い
  IF p_commercial_flow IS NOT NULL AND p_commercial_flow <> '' THEN
    conditions := conditions || format(
      'raw_profile->>''commercialFlow'' = %L', p_commercial_flow);
  END IF;

  -- 雇用形態（正社員 / フリーランス 等）。同上
  IF p_employment_type IS NOT NULL AND p_employment_type <> '' THEN
    conditions := conditions || format(
      'raw_profile->>''employmentType'' = %L', p_employment_type);
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
$function$;

-- ============================================================================
-- 件数側も同じ条件にする
-- ============================================================================
-- 片方だけ直すと「該当3件」と出ているのに一覧には30件並ぶ、という状態になる。
-- 条件の組み立ては上とまったく同じにすること。
DROP FUNCTION IF EXISTS public.count_filter_candidates(text, text, text[], text, integer);

CREATE OR REPLACE FUNCTION public.count_filter_candidates(
  p_data_env        text,
  p_name            text    DEFAULT NULL,
  p_skills          text[]  DEFAULT NULL,
  p_prefecture      text    DEFAULT NULL,
  p_exp_min         integer DEFAULT NULL,
  p_rate_max        integer DEFAULT NULL,
  p_rate_min        integer DEFAULT NULL,
  p_commercial_flow text    DEFAULT NULL,
  p_employment_type text    DEFAULT NULL
)
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
    conditions := conditions || format('name ILIKE %L', '%' || p_name || '%');
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
