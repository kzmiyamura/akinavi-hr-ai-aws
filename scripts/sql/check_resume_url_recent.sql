-- 直近の人材に経歴書リンク（resume_url）が付いているかを時間帯別に見る（2026-09-23）
--
-- ユーザー報告: 「直近の人材に経歴書のリンクが全然ない」
-- 日別では 9/23 は 269件中144件に resume_url があるが、
-- **報告は「直近」なので時間帯で切らないと見えない**（日の平均が隠す）。
--
-- あわせて、添付があったのにリンクが付かなかったケースを分けて数える:
--   ・添付そのものが無かった（本文だけのメール）
--   ・添付はあったが割り当てられなかった（氏名照合ゲートで落ちた等）
-- 本体は返さない。件数だけ。

select
  to_char(created_at at time zone 'Asia/Tokyo', 'MM/DD HH24時') as "受信(JST)",
  count(*)                                                      as "登録",
  count(*) filter (where resume_url is not null)                as "リンクあり",
  count(*) filter (where resume_url is null)                    as "リンクなし",
  -- 添付が1つでもあったか（取り込み時の棚卸しが raw_profile に残る）
  count(*) filter (where
      jsonb_typeof(raw_profile->'allParsedAttachmentLabels') = 'array'
      and jsonb_array_length(raw_profile->'allParsedAttachmentLabels') > 0
  )                                                             as "添付あり",
  -- 添付はあったのにリンクが付かなかった＝割り当てで落ちた
  count(*) filter (where resume_url is null
      and jsonb_typeof(raw_profile->'allParsedAttachmentLabels') = 'array'
      and jsonb_array_length(raw_profile->'allParsedAttachmentLabels') > 0
  )                                                             as "添付ありなのに無リンク",
  count(*) filter (where box_url is not null or drive_url is not null) as "Box/Driveあり"
from candidates
where data_env = 'prod' and merged_into is null
  and created_at >= now() - interval '36 hours'
group by 1
order by 1 desc;
