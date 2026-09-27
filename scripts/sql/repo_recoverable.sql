-- 「リポジトリのマイグレーションで戻せる分」と「戻せない分」を分ける（2026-09-28）
-- 最後のマイグレーションは 2026-09-23。それ以降に出来た行は git のどこにも無い。
WITH cutoff AS (SELECT '2026-09-24'::timestamptz AS t)
SELECT 'skill_master 全体' AS 項目, count(*)::text AS 値, 1 AS ord FROM skill_master
UNION ALL SELECT '  うちマイグレーション後に追加', count(*)::text, 2
  FROM skill_master, cutoff WHERE created_at >= cutoff.t
UNION ALL SELECT '  うち利用実績あり（match_count>0）', count(*)::text, 3
  FROM skill_master WHERE COALESCE(match_count,0) > 0
UNION ALL SELECT 'station_master 全体', count(*)::text, 4 FROM station_master
UNION ALL SELECT 'skill_implications 全体', count(*)::text, 5 FROM skill_implications
UNION ALL SELECT 'agent_companies 全体（人が免許を調べた結果）', count(*)::text, 6 FROM agent_companies
UNION ALL SELECT '  うち人が確認済（unknown/notfound以外）', count(*)::text, 7
  FROM agent_companies WHERE license_status NOT IN ('unknown','notfound')
UNION ALL SELECT 'candidates_archive_light（種は無い）', count(*)::text, 8 FROM candidates_archive_light
UNION ALL SELECT 'submissions（種は無い）', count(*)::text, 9 FROM submissions
ORDER BY 3;
