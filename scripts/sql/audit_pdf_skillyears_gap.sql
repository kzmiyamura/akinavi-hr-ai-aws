-- PDF経歴書で skillYears が空の人材を原因別に数える。
--
-- 取得率は PDF 42% / Excel 95% で PDF だけ低い。ただし「PDFだから」では打ち手が決まらない。
-- 詰まりどころは2つあり、直す場所がまったく違う:
--   ① テキスト層が無い（スキャンPDF）→ 抽出器を直しても取れない。OCR の話になる
--   ② テキストは取れているが年数を読めていない → 抽出器の問題。直せる
--
-- raw_profile->>'text' の長さが決め手。丸ごと転送すると1件35KBなので、
-- 長さだけをサーバー側で集計する。
WITH pdf AS (
  SELECT
    id,
    (SELECT count(*) FROM jsonb_object_keys(coalesce(raw_profile->'skillYears','{}'::jsonb)) k
      WHERE k NOT LIKE '\_%')                              AS sy_cnt,
    coalesce(jsonb_array_length(skills), 0)                AS skill_cnt,
    length(coalesce(raw_profile->>'text',''))              AS text_len,
    coalesce(raw_profile->>'excelParseNotes','')           AS notes,
    created_at
  FROM candidates
  WHERE data_env = 'prod' AND merged_into IS NULL
    AND resume_url ILIKE '%.pdf'
)
SELECT
  CASE
    WHEN sy_cnt > 0                    THEN '1. skillYears あり'
    WHEN text_len = 0                  THEN '2. 本文なし（スキャンPDF/抽出失敗）'
    WHEN skill_cnt = 0                 THEN '3. 本文あり・スキルも0件'
    ELSE                                    '4. 本文あり・スキルは取れた・年数だけ空'
  END                                              AS 区分,
  count(*)                                         AS 件数,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS 割合,
  round(avg(text_len))                             AS 平均本文長,
  round(avg(skill_cnt), 1)                         AS 平均スキル数,
  min(created_at)::date                            AS 最古,
  max(created_at)::date                            AS 最新
FROM pdf
GROUP BY 1
ORDER BY 1;
