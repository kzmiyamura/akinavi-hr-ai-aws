-- skill_master の全件取得が1回あたり何バイトかを測る（2026-08-19）
-- ログ実測: inbound-email が
--   skill_master?select=id,name,category,aliases を **1時間に124回** 呼んでいる。
-- 本体を受け取らずに SQL 側でサイズだけ出す。
SELECT '行数' AS 指標, count(*)::text AS 値 FROM skill_master
UNION ALL
SELECT '1回の取得サイズ(KB)',
       round((SELECT octet_length(json_agg(t)::text) FROM
              (SELECT id, name, category, aliases FROM skill_master) t) / 1024.0, 1)::text
UNION ALL
SELECT '1時間124回として(MB/h)',
       round((SELECT octet_length(json_agg(t)::text) FROM
              (SELECT id, name, category, aliases FROM skill_master) t) * 124 / 1024.0 / 1024.0, 1)::text
UNION ALL
SELECT '1日あたり(MB/日)',
       round((SELECT octet_length(json_agg(t)::text) FROM
              (SELECT id, name, category, aliases FROM skill_master) t) * 124 * 24 / 1024.0 / 1024.0, 1)::text;
