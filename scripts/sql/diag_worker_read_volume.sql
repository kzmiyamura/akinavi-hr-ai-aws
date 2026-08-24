-- ワーカーが1日に読む量を見積もる（2026-08-19）
-- egress の9割が PostgREST で、私の作業分は10MB以下。常駐ワーカーの読み取りを疑う。
--
-- ワーカーは5分サイクル（288回/日）。raw_profile を含む select が複数ある:
--   ① キュー取得        limit 15 / サイクル（raw_profile 込み）
--   ② stale段階の掃除    limit 200 / サイクル（raw_profile 込み）★毎回走る
--   ③ 推薦生成          5件/サイクル（raw_profile 込み・1件ずつ）
--   ④ Box取得待ち       limit 3 / サイクル
WITH sizes AS (
  SELECT avg(pg_column_size(raw_profile))::numeric AS rp_bytes
  FROM candidates WHERE data_env='prod'
)
SELECT 'raw_profile 平均サイズ(KB)' AS 指標,
       round((SELECT rp_bytes FROM sizes)/1024.0, 1)::text AS 値
UNION ALL
SELECT '② staleの対象行数（毎サイクルこれを raw_profile 込みで読む）',
       count(*)::text FROM candidates
       WHERE raw_profile->>'_llm_stage' IN ('body','sonnet')
UNION ALL
SELECT '②の1日あたり転送見積(MB)',
       round((SELECT count(*) FROM candidates WHERE raw_profile->>'_llm_stage' IN ('body','sonnet'))
             * (SELECT rp_bytes FROM sizes) * 288 / 1024.0 / 1024.0, 1)::text
UNION ALL
SELECT '① キュー対象（未校正・直近3日・prod）',
       count(*)::text FROM candidates
       WHERE data_env='prod' AND merged_into IS NULL
         AND raw_profile->>'_llm_checked_at' IS NULL
         AND created_at > now() - interval '3 days'
UNION ALL
SELECT '①の1日あたり転送見積(MB・15件×288サイクル上限)',
       round(15 * (SELECT rp_bytes FROM sizes) * 288 / 1024.0 / 1024.0, 1)::text
UNION ALL
SELECT '③ 推薦の1日あたり転送見積(MB・5件×288サイクル)',
       round(5 * (SELECT rp_bytes FROM sizes) * 288 / 1024.0 / 1024.0, 1)::text;
