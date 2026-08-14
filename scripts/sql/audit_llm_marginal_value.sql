-- AI（常駐ワーカーの Haiku 補正）が regex の結果をどれだけ直しているか。
-- 「もう AI 要らないのでは」を感想でなく数字で見るためのもの。
--
-- raw_profile._llm_applied.fields に「直した項目名」が入る（apply.mjs）。
-- fields が空／キー自体が無い＝AI が触るところが無かった、という意味。
-- 集計行しか返さないので egress は誤差。
WITH checked AS (
  SELECT
    id,
    raw_profile->'_llm_applied'                       AS la,
    jsonb_array_length(COALESCE(raw_profile->'_llm_applied'->'fields', '[]'::jsonb)) AS n_fields
  FROM candidates
  WHERE data_env = 'prod'
    AND merged_into IS NULL
    AND raw_profile ? '_llm_applied'
)
SELECT
  count(*)                                              AS "AI処理済み人数",
  count(*) FILTER (WHERE n_fields = 0)                  AS "直すところ無し",
  round(100.0 * count(*) FILTER (WHERE n_fields = 0) / NULLIF(count(*), 0), 1) AS "無しの割合%",
  round(avg(n_fields), 2)                               AS "平均の修正項目数",
  max(n_fields)                                         AS "最大"
FROM checked;
