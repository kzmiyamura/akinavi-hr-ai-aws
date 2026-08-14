-- AI が直している項目の内訳。どのフィールドを何人ぶん書き換えたか。
-- fields の要素は「skills(+7)」のように補足が付くので、括弧より前を項目名として集計する。
-- 20行程度しか返さない。
SELECT
  regexp_replace(f, '\(.*$', '')                         AS 項目,
  count(*)                                               AS 人数,
  round(100.0 * count(*) / (
    SELECT count(*) FROM candidates
    WHERE data_env = 'prod' AND merged_into IS NULL AND raw_profile ? '_llm_applied'
  ), 1)                                                  AS "対象比%"
FROM candidates c,
     LATERAL jsonb_array_elements_text(
       COALESCE(c.raw_profile->'_llm_applied'->'fields', '[]'::jsonb)) AS f
WHERE c.data_env = 'prod' AND c.merged_into IS NULL
GROUP BY 1
ORDER BY 人数 DESC
LIMIT 20;
