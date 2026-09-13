-- 品質チェック（結果だけを返す版）
--
--   npx supabase db query --linked -f scripts/sql/quality_check.sql
--
-- ■ なぜこれを作ったか
--   `npm run quality`（quality_check.mjs）は判定のために**行を引いてJS側で数えて**いた。
--   raw_profile を丸ごと取る箇所が6つあり、1回で約7MB（閑散日）。
--   繁忙日は15〜20MB、日次で回せば月200〜600MB になる。
--   判定はSQLでできるので、**数える仕事をDBに渡して結果だけ受け取る**。
--   このファイルの戻りは40行ほど・約5KB。
--
-- ■ 使い方の約束
--   ・ここに足すチェックは必ず「1行＝1判定」で返すこと。行を返し始めたら意味が無い
--   ・サンプル（実際の値を見たい）が要るときは、**ローカル控え**を使う:
--       node scripts/archive_query.mjs summary|daily|company|missed
--     本番から本文を引くのは最後の手段（CLAUDE.md の egress 鉄則）
--
-- 期間: 直近7日（人材の保持が7日なので、これ以上遡ってもDBには無い）

with
period as (select now() - interval '7 days' as since),
c as (
  select * from candidates, period
  where data_env = 'prod' and merged_into is null and created_at > period.since
),
-- スキル年数のキー数（_ で始まる内部キーは除く）
sy as (
  select id, (
    select count(*) from jsonb_object_keys(coalesce(raw_profile->'skillYears', '{}'::jsonb)) k
    where k not like '\_%'
  ) as n from c
),
-- 既知のスキル名を先に平坦化する（正式名＋別名を1列に）。
-- 総当たりの NOT EXISTS にすると
-- 候補者スキル × skill_master × aliases で statement timeout になる（2026-09-14 実測）
known as (
  select lower(m.name) as s from skill_master m
  union
  select lower(a.v) from skill_master m,
         lateral jsonb_array_elements_text(coalesce(m.aliases, '[]'::jsonb)) as a(v)
),
-- 人材が持つスキルのうち、辞書に無いもの
unknown_skills as (
  select lower(s.skill) as skill, count(*) as n
  from c, lateral jsonb_array_elements_text(coalesce(c.skills, '[]'::jsonb)) as s(skill)
  left join known k on k.s = lower(s.skill)
  where k.s is null
  group by 1
)
select * from (
  ---- 取り込み ----
  select '01 取り込み' as 区分, '直近7日の登録数' as 項目, count(*)::text as 値, '' as 判定 from c
  union all
  select '01 取り込み', '1日あたり平均', round(count(*)/7.0)::text, '' from c
  union all
  select '01 取り込み', '添付ありの割合',
         round(100.0 * count(*) filter (where raw_profile ? 'attachmentNames') / nullif(count(*),0), 1)::text || '%', ''
    from c

  ---- 抽出の穴 ----
  union all
  select '02 抽出の穴', '氏名が不明',
         count(*) filter (where name is null or name = '不明')::text,
         case when 100.0 * count(*) filter (where name is null or name = '不明') / nullif(count(*),0) > 5
              then '⚠ 5%超' else 'ok' end
    from c
  union all
  select '02 抽出の穴', '経験年数なし',
         count(*) filter (where experience_years is null)::text,
         case when 100.0 * count(*) filter (where experience_years is null) / nullif(count(*),0) > 10
              then '⚠ 10%超' else 'ok' end
    from c
  union all
  -- UNION の枝に LIMIT は置けないので、FROM を使わずスカラー副問い合わせで書く
  select '02 抽出の穴', 'スキル年数が空',
         (select count(*) from sy where n = 0)::text,
         case when 100.0 * (select count(*) from sy where n = 0) / nullif((select count(*) from sy),0) > 30
              then '⚠ 30%超' else 'ok' end
  union all
  select '02 抽出の穴', '最寄駅なし',
         count(*) filter (where raw_profile->>'nearestStation' is null)::text, ''
    from c
  union all
  select '02 抽出の穴', '都道府県なし',
         count(*) filter (where raw_profile->>'prefecture' is null)::text, ''
    from c
  union all
  select '02 抽出の穴', 'スキル0件',
         count(*) filter (where skills is null or jsonb_array_length(skills) = 0)::text, ''
    from c
  union all
  select '02 抽出の穴', '希望単価なし',
         count(*) filter (where desired_rate is null)::text, ''
    from c

  ---- 取りこぼし（メールは来たが人材にならなかった） ----
  union all
  select '03 取りこぼし', '人材メール数（直近7日）',
         count(*)::text, ''
    from ai_logs, period where type = 'candidate' and created_at > period.since
  union all
  select '03 取りこぼし', '登録されなかった数',
         count(*) filter (where linked_id is null)::text,
         case when 100.0 * count(*) filter (where linked_id is null) / nullif(count(*),0) > 10
              then '⚠ 10%超' else 'ok' end
    from ai_logs, period where type = 'candidate' and created_at > period.since
  union all
  select '03 取りこぼし', '未登録が多い送信元 上位5',
         string_agg(x.dom || '(' || x.n || ')', ' / ' order by x.n desc), ''
    from (select lower(split_part(from_address,'@',2)) as dom, count(*) as n
          from ai_logs, period
          where type = 'candidate' and linked_id is null and created_at > period.since
          group by 1 order by 2 desc limit 5) x

  ---- スキル辞書 ----
  union all
  select '04 スキル辞書', 'skill_master に無いスキルの種類',
         (select count(*) from unknown_skills)::text, ''
  union all
  select '04 スキル辞書', '追加候補（3件以上出現）上位8',
         coalesce((select string_agg(skill || '(' || n || ')', ' / ' order by n desc)
                   from (select * from unknown_skills where n >= 3 order by n desc limit 8) y), '(なし)'), ''

  ---- AI 呼び出し ----
  union all
  select '05 AI', 'モデル別 件数/エラー/平均ms',
         string_agg(x.model || ' ' || x.n || '/' || x.err || '/' || x.ms, '  ' order by x.n desc), ''
    from (select coalesce(model,'(なし)') as model, count(*) as n,
                 count(*) filter (where status = 'error') as err,
                 round(avg(duration_ms))::int as ms
          from ai_logs, period where created_at > period.since group by 1) x

  ---- 提案 ----
  union all
  select '06 提案', '直近7日の submissions',
         count(*)::text, ''
    from submissions, period where created_at > period.since

  ---- Box ----
  union all
  select '07 Box', '状態の内訳',
         string_agg(x.st || ' ' || x.n, ' / ' order by x.n desc), ''
    from (select coalesce(box_status,'(なし)') as st, count(*) as n
          from candidates where data_env = 'prod' and box_url is not null group by 1) x
  union all
  select '07 Box', '打ち切り（リンク切れ等）',
         count(*)::text,
         case when count(*) > 0 then '営業から紹介会社へ連絡が要る' else 'ok' end
    from candidates where data_env = 'prod' and box_status = 'failed'

  ---- 派遣・紹介会社 ----
  union all
  select '08 会社', '免許の内訳',
         string_agg(x.st || ' ' || x.n, ' / ' order by x.n desc), ''
    from (select license_status as st, count(*) as n from agent_companies group by 1) x
  union all
  select '08 会社', '会社名が無い行',
         count(*)::text,
         case when count(*) > 0 then '⚠ 照合できないまま残る' else 'ok' end
    from agent_companies where company_name is null or btrim(company_name) = ''

  ---- Storage ----
  union all
  select '09 Storage', 'フォルダ別',
         string_agg(x.f || ' ' || x.sz, ' / ' order by x.bytes desc), ''
    from (select split_part(name,'/',1) as f,
                 pg_size_pretty(sum((metadata->>'size')::bigint)) as sz,
                 sum((metadata->>'size')::bigint) as bytes
          from storage.objects where bucket_id = 'attachments' group by 1) x
) r
order by 区分, 項目;
