-- 昨日(JST)の人材LLM校正の稼働・成功状況
-- JST 2026-08-14 00:00〜24:00 = UTC 2026-08-13 15:00 〜 2026-08-14 15:00
WITH d AS (
  SELECT *
  FROM llm_shadow
  WHERE created_at >= '2026-08-13T15:00:00Z'
    AND created_at <  '2026-08-14T15:00:00Z'
)
SELECT
  coalesce(source, '(null)')            AS source,
  coalesce(model, '(none)')             AS model,
  coalesce(status, '(null)')            AS status,
  count(*)                              AS runs,
  count(DISTINCT candidate_id)          AS candidates,
  round(sum(coalesce(cost_usd,0))::numeric, 4) AS cost_usd
FROM d
GROUP BY 1,2,3
ORDER BY 1,2,3;
