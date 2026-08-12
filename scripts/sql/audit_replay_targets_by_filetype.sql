-- 一括再解析の対象を経歴書のファイル種別で分ける（2026-08-12）
--
-- bulk_replay_missing_skillyears.mjs の対象は「skillYears が空・resume_url が自前Storage」。
-- ただし skillYears を取れるのは Excel 経歴書だけで、PDF/Word は再解析しても空のまま。
-- 実際に効く対象が何件あるのかを先に把握する。
--
-- 実行: npx supabase db query --linked -f scripts/sql/audit_replay_targets_by_filetype.sql

WITH t AS (
  SELECT c.id,
         lower(regexp_replace(split_part(c.resume_url, '?', 1), '^.*\.', '')) AS ext,
         (SELECT count(*) FROM jsonb_object_keys(COALESCE(c.raw_profile->'skillYears', '{}'::jsonb)) k
           WHERE k NOT LIKE '\_%') AS sy_keys
    FROM candidates c
   WHERE c.data_env = 'prod'
     AND c.merged_into IS NULL
     AND c.resume_url LIKE '%supabase.co/storage%'
)
SELECT ext AS 拡張子,
       count(*)                          AS 全体,
       count(*) FILTER (WHERE sy_keys = 0) AS 再解析対象_skillYears空,
       count(*) FILTER (WHERE sy_keys > 0) AS 取得済み
  FROM t
 GROUP BY ext
 ORDER BY count(*) FILTER (WHERE sy_keys = 0) DESC;
