-- 直近で「1通から複数人」登録されたメールを新しい順に出す（2026-09-23）
--
-- 読み取りが正しいかを原本と突き合わせるための入口。
-- 本文は返さない。件名・送信元・人数・時刻だけ。

select
  min(created_at at time zone 'Asia/Tokyo')::timestamp(0)  as "受信(JST)",
  raw_profile->>'from'                                     as "送信元",
  left(coalesce(raw_profile->>'subject', ''), 46)          as "件名",
  count(*)                                                 as "登録人数",
  count(*) filter (where resume_url is not null)           as "経歴書あり",
  count(distinct name)                                     as "氏名の種類",
  count(*) filter (where raw_profile->>'age' is not null)  as "年齢あり",
  count(*) filter (where desired_rate is not null)         as "単価あり",
  count(*) filter (where raw_profile->>'nearestStation' is not null) as "最寄駅あり"
from candidates
where data_env = 'prod' and merged_into is null
  and created_at >= now() - interval '10 hours'
group by raw_profile->>'from', left(coalesce(raw_profile->>'subject', ''), 46)
having count(*) >= 3
order by 1 desc
limit 10;
