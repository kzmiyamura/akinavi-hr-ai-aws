-- raw_profile のどのキーに「.zip」が入っているのかを特定する（2026-08-17）
-- 行本体は返さず、キー名と出現回数だけを返す（egress 対策）。
SELECT kv.key AS キー,
       count(*)::text AS 件数,
       left(min(kv.value::text), 120) AS 値の例
FROM candidates c,
     LATERAL jsonb_each(c.raw_profile) kv
WHERE c.data_env='prod' AND c.merged_into IS NULL
  AND c.raw_profile::text ILIKE '%.zip%'
  AND kv.value::text ILIKE '%.zip%'
GROUP BY kv.key
ORDER BY count(*) DESC
LIMIT 20;
