-- 名簿メールに1人分だけ添付されていた経歴書が、**本人**に付いたかを確かめる（2026-09-23）
--
-- 実物を開いて確認した事実:
--   添付 MK_kasai_Skillsheet.xlsx は「MK・29歳・女性・葛西駅」1人分のスキルシート。
--   同じメールの本文には56人が書かれていた。
--
-- 正しい挙動は「MK にだけ付き、他の55人には付かない」。
-- 他人に付いていたら誤配（最悪）。MK に付いていなければ取りこぼし。

select
  name                                               as "氏名",
  coalesce(raw_profile->>'nearestStation', '-')      as "最寄駅",
  coalesce(raw_profile->>'age', '-')                 as "年齢",
  coalesce(raw_profile->>'gender', '-')              as "性別",
  case when resume_url is null then '—'
       else right(resume_url, 45) end                as "経歴書リンク"
from candidates
where data_env = 'prod' and merged_into is null
  and raw_profile->>'from' = 'sales@code-d.co.jp'
  and created_at >= now() - interval '6 hours'
  and (resume_url is not null or name = 'MK' or raw_profile->>'nearestStation' like '%葛西%')
order by (resume_url is null), name;
