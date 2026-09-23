-- 名簿メールに付いていた添付が「個人の経歴書」なのか「名簿そのもの」なのかを見る（2026-09-23）
--
-- 状況: 53人が登録された1通に添付は1つだけ。inbound-email は氏名照合できないと
-- わざと resume_url を付けない（他人の経歴書を見せない安全側の判定）。
-- だが添付が**名簿そのもの**なら、それは53人全員の資料なので全員に付けてよい。
-- どちらなのかはファイル名で判別できる。

select
  left(coalesce(raw_profile->>'subject', ''), 40)   as "件名",
  raw_profile->>'from'                              as "送信元",
  raw_profile->'allParsedAttachmentLabels'          as "添付ファイル名",
  count(*)                                          as "人数",
  count(*) filter (where resume_url is not null)    as "リンクあり"
from candidates
where data_env = 'prod' and merged_into is null
  and created_at >= now() - interval '24 hours'
  and jsonb_typeof(raw_profile->'allParsedAttachmentLabels') = 'array'
  and jsonb_array_length(raw_profile->'allParsedAttachmentLabels') > 0
group by 1, 2, 3
order by count(*) desc
limit 12;
