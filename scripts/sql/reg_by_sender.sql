-- 送信元ごとの登録人数（本番の実数）。行は引かず、送信元単位に畳んで返す。
-- ローカル控えが本番に追いついていなかったため、こちらを正とする。
select raw_profile->>'from' as from_address,
       count(*) as people,
       count(*) filter (where created_at >= now() - interval '2 days') as people_2d,
       min(created_at at time zone 'Asia/Tokyo')::date as first_day,
       max(created_at at time zone 'Asia/Tokyo')::date as last_day
from public.candidates
where data_env = 'prod' and merged_into is null
  and created_at >= '2026-09-14T00:00:00Z'
group by 1
having count(*) > 0
order by people desc;
