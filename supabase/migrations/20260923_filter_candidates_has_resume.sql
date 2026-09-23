-- 絞り込みに「経歴書あり」を足す（2026-09-23）
--
-- ■ なぜ要るか（実データ）
--   ユーザー報告「直近の人材に経歴書のリンクが全然ない」。調べた結果、壊れてはいなかった:
--
--     13:15 に1通の名簿メールが届き、本文に書かれた56人が登録された。
--     添付は MK_kasai_Skillsheet.xlsx ただ1つ（実物を開いて確認: MK・29歳・女性・
--     葛西駅、1人分のスキルシート）。
--     → MK には正しく付与され、残り55人はそもそも経歴書が送られていない。
--
--   inbound-email は氏名照合できない添付を**わざと付けない**（他人の経歴書を
--   見せる方が危険なため）。この判定は正しく働いている。
--
--   問題は表示側。一覧は新着順なので、経歴書のない55人が画面トップを占め、
--   営業から見ると「リンクのない人ばかり」になる。
--   付与率そのものは改善している（個別紹介メール: 9/16 19% → 9/22 93%）。
--
-- ■ 判定の方針
--   経歴書の在りかは resume_url だけではない。Box・Drive に置く運用もあるので、
--   **resume_url / box_url / drive_url のいずれかがあれば「あり」**とする。
--   ここを resume_url だけにすると、Box 運用の人材が消える。
--
--   読み取れない人を残す/残さないの使い分けは既存に合わせる:
--     単価・稼働時期 … 読み取れない人は残す（取りこぼしを避ける）
--     経歴書の有無   … **真偽がはっきりする項目なので、指定どおりに絞る**
--
-- ■ オーバーロードを避ける
--   引数を足すと古い署名が残って「関数が曖昧」になる（2026-09-21 に踏んだ）。
--   先に現行署名を DROP してから作り直す。

DROP FUNCTION IF EXISTS public.filter_candidates(
  text, text, text[], text, integer, integer, integer, integer, integer,
  text, text, date, text, boolean);
DROP FUNCTION IF EXISTS public.count_filter_candidates(
  text, text, text[], text, integer, integer, integer, text, text, date, text, boolean);

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
  p_available_by    date    DEFAULT NULL,
  p_work_style      text    DEFAULT NULL,
  p_haken_ok        boolean DEFAULT NULL,
  -- 2026-09-23 追加
  p_has_resume      boolean DEFAULT NULL    -- true=経歴書ありのみ / false=無しのみ
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
  p_haken_ok        boolean DEFAULT NULL,
  p_has_resume      boolean DEFAULT NULL
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

-- ── 検証: 影響人数を測る（足す前に測る・鉄則） ─────────────────────────────
select
  count_filter_candidates('prod')                        as "絞り込みなし",
  count_filter_candidates('prod', p_has_resume => true)  as "経歴書あり",
  count_filter_candidates('prod', p_has_resume => false) as "経歴書なし";
