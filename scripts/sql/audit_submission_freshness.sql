-- open 案件ごとに、保存済みマッチング結果の件数と最終更新を見る。
-- 「未実施」や古いスコアが残っていないかの確認用。
SELECT
  left(p.title, 34)                         AS 案件,
  left(p.id::text, 8)                       AS id,
  count(s.id)                               AS 保存件数,
  max(s.created_at)::timestamp(0)           AS 最終更新,
  max(s.match_score)                        AS 最高点
FROM projects p
LEFT JOIN submissions s
       ON s.project_id = p.id AND s.data_env = 'prod'
WHERE p.data_env = 'prod' AND p.status = 'open'
GROUP BY p.id, p.title
ORDER BY 最終更新 DESC NULLS FIRST;
