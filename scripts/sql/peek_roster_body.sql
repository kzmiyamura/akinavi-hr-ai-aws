-- 「同じ送信元＋同じ件名」で56件も登録されているものの正体を見る（2026-09-23）
--
-- 経緯:
--   最初 sales@code-d.co.jp の最古1件を見たら本文は**1人分**（RY・26歳・本厚木）だった。
--   ところが件名「【直個人】【8月～】営業再開！PMO補佐…」では56件が同じ添付
--   （MK_kasai_Skillsheet.xlsx）を共有している。
--   ・本文に56人の名簿が併記されている  … 登録は正しい。添付が1人分なのでリンクが付かない
--   ・同じメールが何度も処理されている  … 重複登録のバグ
--   どちらかを、氏名の重複度と本文の長さで判定する。

select
  name                                              as "氏名",
  count(*)                                          as "同名の件数",
  min(created_at at time zone 'Asia/Tokyo')::time(0) as "最初",
  max(created_at at time zone 'Asia/Tokyo')::time(0) as "最後",
  min(length(raw_profile->>'text'))                 as "本文長",
  count(*) filter (where resume_url is not null)    as "リンクあり"
from candidates
where data_env = 'prod' and merged_into is null
  and raw_profile->>'from' = 'sales@code-d.co.jp'
  and left(coalesce(raw_profile->>'subject', ''), 40) like '【直個人】【8月～】営業再開！PMO補佐%'
  and created_at >= now() - interval '24 hours'
group by name
order by count(*) desc, name
limit 60;
