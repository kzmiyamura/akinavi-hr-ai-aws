-- 役割の妥当性調査 その2: 判定スコアの分布（2026-08-19）
--
-- scoreProseRoles は「本文のどこかに1回でも出現すれば役割を付与」する。
-- 加点は 出現回数(最大3) + 冒頭200字(+3) + 明示ラベル(+2〜) など。
-- スコアが低い（1〜2）ものは「本文のどこかで1〜2回触れられただけ」なので、
-- 本人の役割ではなく案件説明・定型文の巻き添えの可能性が高い。
WITH s AS (
  SELECT c.id, kv.key AS role, (kv.value)::numeric AS score
  FROM candidates c, LATERAL jsonb_each(coalesce(c.raw_profile->'_roleScores','{}'::jsonb)) kv
  WHERE c.data_env='prod' AND c.merged_into IS NULL
)
SELECT role AS 役割,
       count(*)::text AS 付与数,
       count(*) FILTER (WHERE score <= 2)::text AS "スコア2以下(弱い根拠)",
       round(100.0 * count(*) FILTER (WHERE score <= 2) / count(*))::text || '%' AS 弱い割合,
       round(avg(score), 1)::text AS 平均スコア
FROM s
GROUP BY role
ORDER BY count(*) DESC
LIMIT 12;
