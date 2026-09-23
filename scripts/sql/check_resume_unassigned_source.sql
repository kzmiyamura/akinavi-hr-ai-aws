-- 「添付はあるのに経歴書リンクが付かなかった」人材を、元メール単位でまとめる（2026-09-23）
--
-- ユーザー報告「直近の人材に経歴書のリンクが全然ない」の原因切り分け。
-- 時間帯別に見ると 9/23 13時台で 72人中53人が該当し、特定のメールに偏っている。
--
-- inbound-email は、名簿メールで氏名と添付の対応が確定できないとき
-- **わざと resume_url を付けない**（他人の経歴書を見せる方が危険なため）。
-- それが効きすぎているのか、別の原因なのかを、元メール単位の件数で見る。
--
-- 本文は返さない。件名は50文字まで。

select
  coalesce(raw_profile->>'from', '(不明)')                       as "送信元",
  left(coalesce(raw_profile->>'subject', '(件名なし)'), 50)      as "件名",
  count(*)                                                       as "この1通の登録人数",
  count(*) filter (where resume_url is not null)                 as "リンクあり",
  count(*) filter (where resume_url is null)                     as "リンクなし",
  max(jsonb_array_length(
      case when jsonb_typeof(raw_profile->'allParsedAttachmentLabels') = 'array'
           then raw_profile->'allParsedAttachmentLabels' else '[]'::jsonb end
  ))                                                             as "添付の数",
  min(created_at at time zone 'Asia/Tokyo')::time(0)             as "受信(JST)"
from candidates
where data_env = 'prod' and merged_into is null
  and created_at >= now() - interval '24 hours'
  and resume_url is null
  and jsonb_typeof(raw_profile->'allParsedAttachmentLabels') = 'array'
  and jsonb_array_length(raw_profile->'allParsedAttachmentLabels') > 0
group by 1, 2
order by count(*) desc
limit 15;
