-- raw_profile の中身の重さの内訳。
-- 「raw_profile を丸ごと select しない」の根拠を数字で押さえるためのもの。
-- どのキーが太いかが分かれば、必要なキーだけ引く形に直せる。
SELECT
  count(*)                                                     AS 件数,
  pg_size_pretty(sum(pg_column_size(raw_profile))::bigint)     AS raw_profile合計,
  pg_size_pretty(avg(pg_column_size(raw_profile))::bigint)     AS 平均,
  pg_size_pretty(avg(pg_column_size(raw_profile->'parsedGrid'))::bigint)     AS "うちparsedGrid",
  pg_size_pretty(avg(pg_column_size(raw_profile->'text'))::bigint)           AS "うちtext",
  pg_size_pretty(avg(pg_column_size(raw_profile->'attachmentText'))::bigint) AS "うちattachmentText",
  pg_size_pretty(avg(pg_column_size(
    raw_profile - 'parsedGrid' - 'text' - 'attachmentText'))::bigint)        AS "残り(その他キー)"
FROM candidates
WHERE data_env = 'prod'
  AND merged_into IS NULL
  AND duplicate_flag = false;
