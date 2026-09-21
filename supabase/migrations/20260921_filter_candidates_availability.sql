-- ============================================================================
-- 人材の絞り込みに「営業が最初に聞くこと」を足す
--   稼働可能時期 / 常駐・リモート / 派遣可否
-- ============================================================================
-- 営業が案件を受けて最初に確認するのは「いつから動ける人か」。
-- データは87%埋まっている（3,076人中2,674人）のに絞り込めなかった。
--   稼働可能時期 2,674人(87%)  うち即日 871人
--   常駐/リモート 2,024人(66%)  併用可848 / 常駐可772 / リモート希望404
--   派遣可否       950人(31%)
--
-- 稼働可能時期は自由記述。実データの上位は
--   「10月～」496 /「即日」484 /「10月」261 /「即日～」171 /「週5日」133 /
--   「2026年10月1日～」32 /「10/1〜」23 /「2026-10-01」23
-- 月が書かれている形が大半なので、**年月に正規化してから比較**する。
-- 「週5日」のように稼働日数が入っている行もあるが、それは時期ではないので NULL 扱い。
-- ============================================================================

/**
 * 稼働可能時期の自由記述を「その年月の1日」に正規化する。読めなければ NULL。
 *
 * ⚠ 「即日」は**今日**として扱う。今すぐ出せる人を探すのが一番多い用途なので、
 *    NULL にすると肝心の871人が絞り込みから消える。
 * ⚠ 年が書かれていない「10月～」は、**今日以降で一番近いその月**とする。
 *    9月に「10月」と書いてあれば今年の10月、12月に「1月」なら翌年の1月。
 *    素直に今年を入れると、年末に翌年案件が全部「過去」になる。
 */
CREATE OR REPLACE FUNCTION public.parse_available_from(src text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s      text;
  y      int;
  mo     int;
  today  date := current_date;
BEGIN
  IF src IS NULL THEN RETURN NULL; END IF;
  s := translate(src, '０１２３４５６７８９年月日～－', '0123456789' || '年月日~-');

  -- 即日・すぐ・随時 → 今日
  IF s ~ '(即日|即時|すぐ|随時|現在|稼働可能|空き)' THEN
    RETURN today;
  END IF;

  -- 年つき（2026年10月 / 2026-10-01 / 2026/10）
  y  := (regexp_match(s, '(20[0-9]{2})[年/-]'))[1]::int;
  IF y IS NOT NULL THEN
    mo := (regexp_match(s, '20[0-9]{2}[年/-]\s*([0-9]{1,2})'))[1]::int;
    IF mo BETWEEN 1 AND 12 THEN RETURN make_date(y, mo, 1); END IF;
    RETURN NULL;
  END IF;

  -- 年なし（10月 / 10/1）。今日以降で一番近いその月にする
  mo := (regexp_match(s, '(?:^|[^0-9])([0-9]{1,2})\s*(?:月|/)'))[1]::int;
  IF mo IS NULL OR mo < 1 OR mo > 12 THEN RETURN NULL; END IF;
  y := extract(year from today)::int;
  IF make_date(y, mo, 1) < date_trunc('month', today)::date THEN y := y + 1; END IF;
  RETURN make_date(y, mo, 1);
END;
$$;

COMMENT ON FUNCTION public.parse_available_from(text) IS
  '稼働可能時期の自由記述を年月の1日に正規化する。「即日」は今日。年なしの月は今日以降で一番近いその月';

-- ── filter_candidates / count_filter_candidates に3条件を足す ───────────────
-- ⚠ 既定値つきの引数を足すとオーバーロードになり呼び出しが曖昧になる。古い定義を先に落とす。
DROP FUNCTION IF EXISTS public.filter_candidates(text, text, text[], text, integer, integer, integer, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.count_filter_candidates(text, text, text[], text, integer, integer, integer, text, text);

CREATE OR REPLACE FUNCTION public.filter_candidates(
  p_data_env        text,
  p_name            text    DEFAULT NULL,
  p_skills          text[]  DEFAULT NULL,
  p_prefecture      text    DEFAULT NULL,
  p_exp_min         integer DEFAULT NULL,
  p_limit           integer DEFAULT 100,
  p_offset          integer DEFAULT 0,
  p_rate_max        integer DEFAULT NULL,
  p_rate_min        integer DEFAULT NULL,
  p_commercial_flow text    DEFAULT NULL,
  p_employment_type text    DEFAULT NULL,
  -- 2026-09-21 追加
  p_available_by    date    DEFAULT NULL,   -- この日までに稼働できる人
  p_work_style      text    DEFAULT NULL,   -- '常駐可' / '併用可' / 'リモート希望'
  p_haken_ok        boolean DEFAULT NULL    -- 派遣可否
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
  IF p_name IS NOT NULL AND p_name <> '' THEN
    conditions := conditions || format('name ILIKE %L', '%' || p_name || '%');
  END IF;
  IF p_prefecture IS NOT NULL AND p_prefecture <> '' THEN
    conditions := conditions || format('raw_profile->>''prefecture'' = %L', p_prefecture);
  END IF;
  IF p_exp_min IS NOT NULL THEN
    conditions := conditions || format('COALESCE(experience_years, 0) >= %s', p_exp_min);
  END IF;
  -- 単価は読み取れない人を残す（自由記述で数値化できない人が一定数いるため）
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
  -- 稼働可能時期。単価と同じく**読み取れない人は残す**（87%は埋まっているが、
  -- 「週5日」のように時期でない値が入っている行もあるため）
  IF p_available_by IS NOT NULL THEN
    conditions := conditions || format(
      '(parse_available_from(raw_profile->>''availableFrom'') IS NULL'
      ' OR parse_available_from(raw_profile->>''availableFrom'') <= %L)', p_available_by);
  END IF;
  -- 常駐・リモートは読み取れない人を通さない（案件側の条件が厳しいため曖昧だと使えない）
  IF p_work_style IS NOT NULL AND p_work_style <> '' THEN
    conditions := conditions || format('raw_profile->>''workStyleTag'' = %L', p_work_style);
  END IF;
  IF p_haken_ok IS NOT NULL THEN
    conditions := conditions || format(
      '(raw_profile->>''hakenOk'')::boolean = %L', p_haken_ok);
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

CREATE OR REPLACE FUNCTION public.count_filter_candidates(
  p_data_env        text,
  p_name            text    DEFAULT NULL,
  p_skills          text[]  DEFAULT NULL,
  p_prefecture      text    DEFAULT NULL,
  p_exp_min         integer DEFAULT NULL,
  p_rate_max        integer DEFAULT NULL,
  p_rate_min        integer DEFAULT NULL,
  p_commercial_flow text    DEFAULT NULL,
  p_employment_type text    DEFAULT NULL,
  p_available_by    date    DEFAULT NULL,
  p_work_style      text    DEFAULT NULL,
  p_haken_ok        boolean DEFAULT NULL
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
