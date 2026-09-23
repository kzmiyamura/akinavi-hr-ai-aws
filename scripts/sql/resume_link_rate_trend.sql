-- 経歴書リンクの付与率の推移（2026-09-23）
--
-- ユーザー報告「直近の人材に経歴書のリンクが全然ない」。
-- 一覧に並ぶ人の多くは**名簿メール由来**（1通の本文に何十人も書かれ、添付は0〜1件）で、
-- 構造的にリンクが付きようがない。個別紹介のメールと混ぜて平均を見ると
-- 「急に壊れた」のか「元からそう」なのかが分からない。
--
-- そこで **1通あたりの登録人数** でメールを2種類に分けて付与率を比べる:
--   個別紹介 … その元メールから登録されたのが 1〜2人
--   名簿     … 3人以上
--
-- 本体は返さない。件数と率だけ。

with per_mail as (
  select
    id, resume_url, created_at,
    -- 元メール単位のキー（送信元＋件名）
    coalesce(raw_profile->>'from', '') || '|' || left(coalesce(raw_profile->>'subject', ''), 60) as mail_key
  from candidates
  where data_env = 'prod' and merged_into is null
    and created_at >= now() - interval '8 days'
),
sized as (
  select p.*, count(*) over (partition by p.mail_key) as people_in_mail
  from per_mail p
)
select
  (created_at at time zone 'Asia/Tokyo')::date as "日付(JST)",
  case when people_in_mail <= 2 then '個別紹介(1〜2人)' else '名簿(3人以上)' end as "メール種別",
  count(*)                                                       as "登録",
  count(*) filter (where resume_url is not null)                 as "リンクあり",
  round(100.0 * count(*) filter (where resume_url is not null) / count(*)) as "付与率%"
from sized
group by 1, 2
order by 1 desc, 2;
