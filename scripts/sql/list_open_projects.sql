-- open 案件の一覧（同名案件の区別用）。8行だけ返す。
SELECT
  left(id::text, 8)                                        AS id,
  title,
  client,
  to_char(created_at, 'MM/DD HH24:MI')                     AS 登録,
  raw_data->'aiInterpretation'->>'requiredRole'            AS 要求役割,
  (SELECT count(*) FROM submissions s
    WHERE s.project_id = p.id AND s.data_env = 'prod')     AS 提案数
FROM projects p
WHERE data_env = 'prod' AND status = 'open'
ORDER BY title, created_at;
