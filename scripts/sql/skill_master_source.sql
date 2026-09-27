SELECT COALESCE(source,'(なし)') AS 由来, count(*)::text AS 行数,
       to_char(min(created_at),'MM/DD') AS 最古, to_char(max(created_at),'MM/DD') AS 最新
FROM skill_master GROUP BY 1 ORDER BY 2 DESC;
