-- ============================================================================
-- DB掃除 ①② 保持期間の見直しと、出口の無い表への出口づけ
-- ============================================================================
-- 目的: 無料版の上限（DB 500MB）に対する余裕を作る。2026-09-18 実測で 326MB＝65%。
--
-- ⚠ この移行は「これから増える分」を止めるだけ。**既にある分は縮まない**。
--    Postgres の DELETE は行に死んだ印を付けるだけで、ディスクは返らない。
--    今ある分を返すには scripts/sql/db_cleanup_once_20260918.sql を流すこと。
--
-- 実測（2026-09-18）:
--   ai_logs                55,994行 / 108MB（本体55 + 索引8 + TOAST44）
--                          14日保持。7日より古い分が 36MB
--   cron.job_run_details   40,840行 /  31MB / 最古 2026-05-02
--                          **掃除する処理が存在しない**。7日より古い行が 38,281
-- ============================================================================

-- ── ① ai_logs を 14日 → 7日 ────────────────────────────────────────────────
--
-- なぜ7日でよいか（読み手を全部確認した）:
--   scripts/sql/quality_check.sql      … 7日（そのまま動く）
--   src/pages/MonitorPage.tsx          … 「今日 / 7日 / 30日」の3択。
--                                        30日は今でも14日ぶんしか出ていない（保持が14日）。
--                                        7日は完全に埋まる（7日より古い分だけ消すため）
--   scripts/check_extraction.mjs       … 既定14日。**--days 7 を付けないと
--                                        「取りこぼし無し」に見える**ので既定も直す
--                                        （別コミット。引けなかったを「無い」と書かないため）
--
-- 保持を変えるときは「何のために何日なのか」を残す（2026-09-16 の教訓）。
--   7日 = 監視画面の最長表示（7日）と品質チェック（7日）に合わせた値。
--   これより短くすると画面が空になる。長くしても誰も読まない。
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'ailogs-cleanup-daily';
  if v_jobid is null then
    raise exception 'ailogs-cleanup-daily が見つかりません。ジョブ名が変わっていないか確認すること';
  end if;
  perform cron.alter_job(
    job_id  := v_jobid,
    command := $cmd$
      -- 保持7日: 監視画面の最長表示と品質チェックに合わせた値（2026-09-18）
      DELETE FROM public.ai_logs WHERE created_at < NOW() - INTERVAL '7 days';
      -- メール重複判定のハッシュ。2日で十分（元から）
      DELETE FROM public.app_config WHERE key LIKE 'ehash_%' AND updated_at < NOW() - INTERVAL '2 days';
    $cmd$
  );
end $$;

-- ── ② cron.job_run_details に掃除を付ける ──────────────────────────────────
--
-- pg_cron が自分の実行結果を書き足す表。書く処理はあるのに消す処理が無く、
-- 2026-05-02 から 40,840行・31MB まで伸びていた。
-- 保持7日 = 「cron が動いていない」を疑ったときに直近1週間を追えれば足りる。
-- 実行時刻は ai_logs の掃除（17:00 UTC）とずらして 17:30 UTC にする。
--
-- ⚠ 自分自身の実行記録も対象になるが、start_time で切るので走っている行は消えない。
select cron.schedule(
  'cron-history-cleanup-daily',
  '30 17 * * *',
  $cmd$
    DELETE FROM cron.job_run_details WHERE start_time < NOW() - INTERVAL '7 days';
  $cmd$
);

-- ── 確認 ────────────────────────────────────────────────────────────────────
-- 流したあと、この2行が期待どおりか見る:
--   select jobname, schedule, left(command, 80) from cron.job
--    where jobname in ('ailogs-cleanup-daily','cron-history-cleanup-daily');
