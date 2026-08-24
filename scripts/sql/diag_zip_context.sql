-- 「.zip」がどこに現れているのかを確かめる（2026-08-17）
-- attachmentNames が [] なのに raw_profile に .zip があるため、
-- 本文中の記述なのか、添付インベントリなのかを切り分ける。
SELECT c.name,
       c.created_at::date::text AS 取込日,
       coalesce(c.raw_profile->>'rawAttachmentCount', '(記録なし)') AS 生添付数,
       coalesce(c.raw_profile->>'attachmentNames', '(記録なし)') AS 添付名,
       coalesce(c.raw_profile->>'sourceAttachmentCount', '-') AS 抽出成功数,
       (c.raw_profile->>'text') ILIKE '%.zip%' AS 本文にzip,
       -- 本文中の .zip の周辺を切り出す
       left(substring(c.raw_profile->>'text' from '.{0,60}\.zip.{0,40}'), 110) AS zip前後
FROM candidates c
WHERE c.data_env='prod' AND c.merged_into IS NULL
  AND c.raw_profile::text ILIKE '%.zip%'
ORDER BY c.created_at DESC
LIMIT 8;
