-- 名簿（1通に複数人）由来の人材の品質を、名簿特有の壊れ方で測る。
-- truth チェック（quality_truth.mjs）は「原本とDB行が1対1」だけを採点しており、
-- 名簿は personCount!==1 で除外されている。つまりここは一度も測っていない領域。
-- 本体は返さない（egress 対策）。
with c as (
  select c.id, c.name, c.desired_rate, c.experience_years,
         c.raw_profile->>'nearestStation' as station,
         c.raw_profile->>'from'           as src,
         date_trunc('minute', c.created_at) as t,
         c.raw_profile->'roles'           as roles,
         c.raw_profile->>'resume_url'     as resume
  from candidates c
  where c.data_env='prod' and c.merged_into is null
),
g as (  -- 同じ送信元・同じ分に作られた人材を「同じメール由来」とみなす（近似）
  select c.*, count(*) over (partition by c.src, c.t) as 同時人数
  from c
),
roster as (select * from g where 同時人数 >= 2)
select '01 規模' as 区分, '名簿由来の人材' as 項目,
       count(*)::text as 値,
       round(100.0*count(*)/(select count(*) from g), 1)::text || '%' as 参考
  from roster
union all
select '01 規模', '名簿の最大人数', max(同時人数)::text, '' from roster
union all
-- ① 幽霊人材: 氏名が駅名そのもの（過去に「駅名人材11件」の実害）
select '02 幽霊', '氏名が駅名と一致',
       count(*)::text,
       coalesce(left(string_agg(distinct r.name, ' / '), 60), '')
  from roster r
 where exists (select 1 from station_master s where s.name = r.name)
union all
-- ② 幽霊人材: 氏名が学校・会社・見出し語っぽい
select '02 幽霊', '氏名が学校・法人・見出し語',
       count(*)::text,
       coalesce(left(string_agg(distinct r.name, ' / '), 60), '')
  from roster r
 where r.name ~ '(大学|高校|学園|学院|専門学校|株式会社|有限会社|合同会社)$'
    or r.name ~ '^(氏名|名前|要員|技術者|人材|担当|スキル|工程|備考|単価|年齢|性別)$'
union all
-- ③ 兄弟ブロック間の値の混入: 同じ名簿の全員が同じ単価
select '03 混入', '全員が同じ希望単価の名簿',
       count(*)::text, '名簿単位'
  from (select src, t from roster
         group by src, t
        having count(distinct coalesce(desired_rate,'(空)')) = 1
           and count(*) >= 3) x
union all
-- ④ 兄弟ブロック間の値の混入: 同じ名簿の全員が同じ駅
select '03 混入', '全員が同じ最寄駅の名簿',
       count(*)::text, '名簿単位'
  from (select src, t from roster
         group by src, t
        having count(distinct coalesce(station,'(空)')) = 1
           and count(*) >= 3
           and count(*) filter (where station is not null) > 0) x
union all
-- ⑤ 充足率: 名簿由来と単独で差があるか
select '04 充足率', '名簿由来: 氏名あり',
       round(100.0*count(*) filter (where name is not null and name <> '不明')/nullif(count(*),0),1)::text || '%', ''
  from roster
union all
select '04 充足率', '単独由来: 氏名あり',
       round(100.0*count(*) filter (where name is not null and name <> '不明')/nullif(count(*),0),1)::text || '%', ''
  from g where 同時人数 = 1
union all
select '04 充足率', '名簿由来: 最寄駅あり',
       round(100.0*count(*) filter (where station is not null)/nullif(count(*),0),1)::text || '%', ''
  from roster
union all
select '04 充足率', '単独由来: 最寄駅あり',
       round(100.0*count(*) filter (where station is not null)/nullif(count(*),0),1)::text || '%', ''
  from g where 同時人数 = 1
union all
select '04 充足率', '名簿由来: 希望単価あり',
       round(100.0*count(*) filter (where desired_rate is not null)/nullif(count(*),0),1)::text || '%', ''
  from roster
union all
select '04 充足率', '単独由来: 希望単価あり',
       round(100.0*count(*) filter (where desired_rate is not null)/nullif(count(*),0),1)::text || '%', ''
  from g where 同時人数 = 1
union all
select '04 充足率', '名簿由来: 役割あり',
       round(100.0*count(*) filter (where coalesce(jsonb_array_length(roles),0) > 0)/nullif(count(*),0),1)::text || '%', ''
  from roster
union all
select '04 充足率', '単独由来: 役割あり',
       round(100.0*count(*) filter (where coalesce(jsonb_array_length(roles),0) > 0)/nullif(count(*),0),1)::text || '%', ''
  from g where 同時人数 = 1
order by 1, 2;
