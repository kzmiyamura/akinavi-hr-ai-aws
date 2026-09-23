-- 名簿メールから一度に登録された人材の中身を見る（2026-09-23）
--
-- 「【直個人】…」という**個人1名**の件名のメールから53人が登録されていた。
-- 結論: 幽霊ではなく**実在する別人56人**だった（年齢・性別・最寄駅・単価がすべて異なる）。
-- 件名は1名分でも本文が名簿になっている、という取引先の書き方によるもの。
-- 本文・raw_profile は引かない。

select
  name                                         as "氏名",
  coalesce(desired_rate::text, '-')            as "希望単価",
  coalesce(raw_profile->>'age', '-')           as "年齢",
  coalesce(raw_profile->>'gender', '-')        as "性別",
  coalesce(raw_profile->>'nearestStation', '-') as "最寄駅",
  coalesce(experience_years::text, '-')        as "経験年数",
  coalesce(jsonb_array_length(skills)::text, '0') as "スキル数"
from candidates
where data_env = 'prod' and merged_into is null
  and raw_profile->>'from' = 'sales@code-d.co.jp'
  and created_at >= now() - interval '24 hours'
order by name
limit 60;
