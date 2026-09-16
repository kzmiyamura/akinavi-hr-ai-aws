-- 人材メールなのに登録されなかった 2,594件（直近7日・21.5%）の理由を数える。
-- respondSkipped が ai_result.reason に理由を書いているので、それを集計するだけで足りる。
-- 本体は返さない（egress 対策）。
with period as (select now() - interval '7 days' as since)
select coalesce(a.ai_result->>'reason', '(理由なし)') as 理由,
       a.status                                       as 状態,
       count(*)                                       as 件数,
       round(100.0 * count(*) / sum(count(*)) over (), 1) as "割合%",
       left(string_agg(distinct lower(split_part(a.from_address,'@',2)), ' / '), 90) as 送信元
  from ai_logs a, period
 where a.type = 'candidate'
   and a.linked_id is null
   and a.created_at > period.since
 group by 1, 2
 order by 3 desc
 limit 20;
