-- Free の DB 500MB に当たるまで何日あるかを測る（2026-09-26）
-- 掃除が無い表だけが本当のリスク。7日保持の表は頭打ちになる。
WITH ai AS (
  SELECT 'ai_logs 最古' AS 項目, to_char(min(created_at),'YYYY-MM-DD') AS 値, 0 AS ord FROM ai_logs
  UNION ALL SELECT 'ai_logs 行数', count(*)::text, 1 FROM ai_logs
  UNION ALL SELECT 'ai_logs 直近7日', count(*)::text, 2 FROM ai_logs WHERE created_at > now() - interval '7 days'
  UNION ALL SELECT 'error_logs 最古', to_char(min(occurred_at),'YYYY-MM-DD'), 3 FROM error_logs
  UNION ALL SELECT 'error_logs 行数', count(*)::text, 4 FROM error_logs
  UNION ALL SELECT 'candidates 最古', to_char(min(created_at),'YYYY-MM-DD'), 5 FROM candidates
  UNION ALL SELECT 'archive_light 最古', to_char(min(created_at),'YYYY-MM-DD'), 6 FROM candidates_archive_light
  UNION ALL SELECT 'archive_light 行数', count(*)::text, 7 FROM candidates_archive_light
  UNION ALL SELECT 'submissions 最古', to_char(min(created_at),'YYYY-MM-DD'), 8 FROM submissions
)
SELECT 項目, 値 FROM ai ORDER BY ord;
