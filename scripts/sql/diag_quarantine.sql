-- 隔離された人材の内訳（2026-08-19）
-- ワーカーが「非人材」と判定して一覧から外したもの。Issue が乱立しているため妥当性を見る。
SELECT raw_profile->'_quarantine'->>'reason' AS 判定理由,
       count(*)::text AS 件数,
       min(created_at)::date::text AS 最古,
       max(created_at)::date::text AS 最新
FROM candidates
WHERE data_env='prod' AND raw_profile ? '_quarantine'
GROUP BY 1 ORDER BY count(*) DESC;
