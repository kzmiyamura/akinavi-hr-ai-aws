-- 日別の登録数（2026-08-19）
-- 「7日平均258人」は保持期間の削除で古い日が消えている可能性があるため、日別で見る。
SELECT to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'MM/DD') AS 日,
       count(*)::text AS 現存する登録数
FROM candidates
WHERE data_env='prod' AND created_at > now() - interval '9 days'
GROUP BY 1 ORDER BY 1;
