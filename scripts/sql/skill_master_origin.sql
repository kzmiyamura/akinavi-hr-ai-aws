-- skill_master の行が「いつ」出来たかを日別に出す（2026-09-28）
-- 目的: コミット済みのマイグレーション／SQLファイル以外で行が足されていないかを確かめる。
-- 日付がマイグレーションの日付と一致していれば、git から作り直せるということ。
SELECT to_char(created_at, 'YYYY-MM-DD') AS 作成日, count(*)::text AS 行数
FROM skill_master GROUP BY 1 ORDER BY 1;
