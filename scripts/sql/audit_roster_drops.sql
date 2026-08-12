-- 名簿（複数人メール）の取りこぼし検出。読み取りのみ・サーバー側集計。
-- inbound-email はゾーンT台帳を raw_profile.pipeline_trace に残す:
--   invariantViolations … サイレント失敗の検出器（空でなければどこかでこけている）
--   summary            … メール内の全エントリ（添付・名簿行）の最終ステージコード
-- trace は同じメール由来の全候補者レコードに複製されるため、メール単位で dedupe する。
-- 出力: k列の接頭辞  A_=全体件数 / V_=違反コード別 / F_=エントリ最終コード別
with emails as (
  select distinct on (
      c.raw_profile ->> 'from',
      c.raw_profile ->> 'subject',
      c.raw_profile ->> 'emailReceivedAt')
    c.raw_profile -> 'pipeline_trace' as trace
  from candidates c
  where c.data_env = 'prod'
    and c.merged_into is null
    and c.created_at >= now() - interval '3 days'
    and c.raw_profile ? 'pipeline_trace'
)
select k, cnt from (
  select 'A_メール数（trace保有）' as k, count(*)::bigint as cnt from emails
  union all
  select 'A_違反ありメール数',
         count(*) filter (where jsonb_array_length(
           case when jsonb_typeof(trace -> 'invariantViolations') = 'array'
                then trace -> 'invariantViolations' else '[]'::jsonb end) > 0)
  from emails
  union all
  select 'V_' || left(v, 70), count(*)
  from emails,
       jsonb_array_elements_text(
         case when jsonb_typeof(trace -> 'invariantViolations') = 'array'
              then trace -> 'invariantViolations' else '[]'::jsonb end) v
  group by 1
  union all
  select 'F_' || split_part(s.code, '(', 1), count(*)
  from emails,
       jsonb_each_text(
         case when jsonb_typeof(trace -> 'summary') = 'object'
              then trace -> 'summary' else '{}'::jsonb end) s(entry_id, code)
  group by 1
) t
order by k;
