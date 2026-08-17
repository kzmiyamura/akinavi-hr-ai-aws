-- ai・more（k.asakura）由来の人材に、同じ役割が一律で付いていないかを確認する（2026-08-17）
-- 疑い: 本文冒頭の営業定型文「以下要員以外にも多数 開発、テスター、インフラ(SV,NW運用監視〜構築設計)、
--       ヘルプデスク,キッティング等エンジニアがおります」を本人の役割として拾っている。
WITH src AS (
  SELECT c.id, c.name,
         (c.raw_profile->>'from' ILIKE '%ai-more%') AS is_aimore,
         coalesce(c.raw_profile->'roles', '[]'::jsonb) AS roles
  FROM candidates c
  WHERE c.data_env='prod' AND c.merged_into IS NULL
)
SELECT 'ai・more 由来の人材' AS 指標, count(*)::text AS 値 FROM src WHERE is_aimore
UNION ALL SELECT '  役割に「運用保守」', count(*)::text FROM src WHERE is_aimore AND roles ? '運用保守'
UNION ALL SELECT '  役割に「ヘルプデスク」', count(*)::text FROM src WHERE is_aimore AND roles ? 'ヘルプデスク'
UNION ALL SELECT '  役割に「PMO」', count(*)::text FROM src WHERE is_aimore AND roles ? 'PMO'
UNION ALL SELECT '  役割が5個以上', count(*)::text FROM src WHERE is_aimore AND jsonb_array_length(roles) >= 5
UNION ALL SELECT '  役割の平均個数',
  round(avg(jsonb_array_length(roles)), 2)::text FROM src WHERE is_aimore
UNION ALL SELECT '── 比較 ── ai・more 以外の人材', count(*)::text FROM src WHERE NOT is_aimore
UNION ALL SELECT '  役割に「運用保守」', count(*)::text FROM src WHERE NOT is_aimore AND roles ? '運用保守'
UNION ALL SELECT '  役割に「ヘルプデスク」', count(*)::text FROM src WHERE NOT is_aimore AND roles ? 'ヘルプデスク'
UNION ALL SELECT '  役割の平均個数',
  round(avg(jsonb_array_length(roles)), 2)::text FROM src WHERE NOT is_aimore;
