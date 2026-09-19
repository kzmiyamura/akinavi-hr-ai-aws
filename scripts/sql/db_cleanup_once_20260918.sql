-- ============================================================================
-- DB掃除 ③ 今あるぶんを実際にディスクへ返す（1回だけ・人が読んでから流す）
-- ============================================================================
-- 20260918_db_cleanup_retention.sql は「これから増える分」を止めるだけで、
-- **今ある分は縮まない**。Postgres の DELETE は行に死んだ印を付けるだけで、
-- 空いた場所は次の書き込みに再利用されるが、ディスク使用量としては返らない。
-- Supabase の 500MB はディスクで数えるので、返すには表と索引を作り直す。
--
-- ⚠ VACUUM FULL と REINDEX CONCURRENTLY は**トランザクションの中で実行できない**。
--    `supabase db query -f` が1トランザクションで包む場合は
--    「cannot run inside a transaction block」で落ちる。そのときは1文ずつ流すこと。
--
-- ⚠ 実行前後で必ず scripts/sql/db_size.sql を流して、効いた量を記録する。
--    「やった」ではなく「何MB返った」を残す。
--
-- ============================================================================
-- 【実行済み 2026-09-19】結果
-- ============================================================================
--   DB 全体          327 MB (65%) → 206 MB (41%)   **121MB 返った**
--
--   消した行          ai_logs 25行 / cron履歴 156行 / ehash 533行
--                    （保持の移行が効いていたので少ない。効いたのは下の作り直し）
--
--   表ごと            ai_logs      108 MB → 42 MB
--                       内訳 本体 55→21 / 索引 8.3→2.0 / TOAST 44→19
--                     candidates    96 MB → 80 MB（索引 44→28。本体2.6 TOAST50 は実データ）
--                     candidate_skills 25 MB → 17 MB
--                     cron.job_run_details 32 MB → 上位8から消えた
--
--   所要              VACUUM FULL cron履歴 8秒 / ai_logs 22秒
--                     REINDEX raw_profile_gin 18秒 / candidate_skills 12秒 /
--                     archive_light 10秒（CONCURRENTLY なので読み書きは止めていない）
--   壊れた索引        0件（pg_index の indisvalid=false は無し）
--   未使用索引        24MB/159本 → 17MB/155本（20260918_drop_unused_indexes.sql も適用）
--
--   ※ supabase db query -f はトランザクションで包まないので、
--     VACUUM FULL / REINDEX CONCURRENTLY はそのまま流せた（1文ずつ別ファイルで実行）。
-- ============================================================================

-- ── 手順1: 古い行を消す（保持期間に合わせる） ───────────────────────────────
-- 移行を当てていれば翌日の cron が同じことをするが、待たずに今戻したいので手で1回。
-- 件数を出してから消す。0件なら移行が既に効いている。
DELETE FROM public.ai_logs            WHERE created_at < NOW() - INTERVAL '7 days';
DELETE FROM cron.job_run_details      WHERE start_time < NOW() - INTERVAL '7 days';

-- ── 手順2: 表を作り直してディスクを返す ─────────────────────────────────────
--
-- VACUUM FULL は表に ACCESS EXCLUSIVE ロックを取る＝その間その表は読めない。
-- 対象は2つだけで、どちらも短時間で終わる見込み:
--   cron.job_run_details … 31MB。書くのは pg_cron だけなので止めても影響が無い
--   ai_logs              … 108MB。監視画面が読むが、数秒〜十数秒の想定
-- **poll-email が走っている最中は避ける**（5分ごとなので、実行直後を狙う）。
VACUUM FULL cron.job_run_details;
VACUUM FULL public.ai_logs;

-- ── 手順3: 膨れた索引を作り直す ─────────────────────────────────────────────
--
-- candidates は3,064行しかないのに索引が44MB（本体は2.6MB）。
-- 人材は7日で入れ替わる＝毎日入れて消しているので、索引が膨れている。
-- 中でも candidates_raw_profile_gin が34MB。GIN は更新が多いと特に膨れる。
--
-- CONCURRENTLY なので**読み書きを止めずに**作り直せる（PostgreSQL 17.6 で利用可）。
-- 失敗すると invalid な索引が残るので、後始末の確認クエリを下に置いた。
--
-- ※ 昨日 raw_profile から「メール全文のコピー」を外した（複数人材ブロックに
--   34人ぶんの本文が入っていた・実測11MB）。この索引はその本文も引いていたので、
--   作り直すと二重に効く。
REINDEX INDEX CONCURRENTLY public.candidates_raw_profile_gin;
REINDEX TABLE CONCURRENTLY public.candidate_skills;
REINDEX TABLE CONCURRENTLY public.candidates_archive_light;

-- ── 手順4: 後始末の確認 ─────────────────────────────────────────────────────
-- CONCURRENTLY が途中で失敗すると、使われない索引が残る。0件であること。
--   select indexrelid::regclass as 壊れた索引
--     from pg_index where not indisvalid;
-- 残っていたら DROP INDEX して、もう一度 REINDEX する。
