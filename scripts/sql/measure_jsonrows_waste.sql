-- raw_profile.jsonRows が実際にどれだけ転送されているかを測る（2026-09-23）
--
-- 状況:
--   jsonRows は inbound-email が raw_profile に書き込むが、**読み手がいない**。
--   画面（src/）にもワーカー（scripts/）にも参照が無く、index.ts のコメントにも
--   「HF品質チェック用の補助データ」とある。
--   一方でワーカーのキュー取得は `select=...,raw_profile,...` と丸ごと引くため、
--   処理する人数ぶんだけ毎日転送されている。
--
-- 本体は返さない。バイト数だけ。

with rp as (
  select
    c.id,
    octet_length(c.raw_profile::text)                                as whole,
    coalesce(octet_length((c.raw_profile->'jsonRows')::text), 0)       as json_rows,
    coalesce(octet_length((c.raw_profile->'attachmentText')::text), 0) as attach_text,
    coalesce(octet_length((c.raw_profile->'grid')::text), 0)           as grid,
    (c.raw_profile ? 'jsonRows')                                     as has_json_rows
  from candidates c
  where c.data_env = 'prod' and c.raw_profile is not null
)
select
  count(*)                                                     as "人材数",
  count(*) filter (where has_json_rows)                        as "jsonRowsを持つ人",
  pg_size_pretty(sum(whole))                                   as "raw_profile 合計",
  pg_size_pretty(sum(json_rows))                               as "うち jsonRows",
  round(100.0 * sum(json_rows) / nullif(sum(whole), 0), 1)     as "jsonRows の割合%",
  pg_size_pretty(sum(attach_text))                             as "うち attachmentText",
  pg_size_pretty(sum(grid))                                    as "うち grid",
  pg_size_pretty(avg(whole)::bigint)                           as "1件平均",
  pg_size_pretty(avg(whole - json_rows)::bigint)               as "jsonRowsを抜いた1件平均",
  -- ワーカーは1日300人ぶん raw_profile を丸ごと引く
  pg_size_pretty((avg(json_rows) * 300)::bigint)               as "ワーカー300件/日のjsonRows転送"
from rp;
