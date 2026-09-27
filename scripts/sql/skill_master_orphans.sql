-- コミット済みファイルに対応する日付が無い skill_master の行（2026-09-28）
-- 06-04 / 06-27 / 06-29 の3日分。これらは add_skill.mjs で手で足された可能性が高い。
SELECT to_char(created_at,'MM/DD') AS 作成日, name AS スキル名, category AS 分類,
       COALESCE(match_count,0)::text AS 一致回数,
       COALESCE(jsonb_array_length(aliases),0)::text AS 別名数
FROM skill_master
WHERE created_at::date IN ('2026-06-04','2026-06-27','2026-06-29')
ORDER BY created_at, name;
