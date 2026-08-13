-- マッチング件数の集計を SQL 側でやる。
--
-- これまで画面は submissions を select('project_id, candidate_id') で全件引いて
-- JS で数えていた。PostgREST の既定上限は 1000 行なので、行が 1000 を超えた時点で
-- 件数が黙って頭打ちになる。実際 2026-08-13 時点で PowerShell 案件だけで 502 行あり、
-- 画面には「308件のマッチング」と出ていた（数字に根拠がない状態）。
-- 併せて 1000 行ぶんの egress も無駄だった。
--
-- n     = 保存済みマッチング件数（ルールスコアのみの人も含む）
-- n_ai  = うち AI が採点・理由を書いた件数（高速モードでは上位N名だけ）
create or replace function submission_counts(p_data_env text default 'prod')
returns table (kind text, ref_id uuid, n bigint, n_ai bigint)
language sql
stable
as $$
  select 'project'::text, project_id, count(*),
         count(*) filter (where coalesce(ai_summary, '') <> '')
    from submissions
   where data_env = p_data_env
   group by project_id
  union all
  select 'candidate'::text, candidate_id, count(*),
         count(*) filter (where coalesce(ai_summary, '') <> '')
    from submissions
   where data_env = p_data_env
   group by candidate_id
$$;

grant execute on function submission_counts(text) to anon, authenticated, service_role;
