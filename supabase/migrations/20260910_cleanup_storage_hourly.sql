-- cleanup-storage を毎日1回 → 毎時に変える（2026-09-10）
--
-- 経緯: 保持日数と掃除間隔は足し算で効く。日1回だと、ファイルは実質
-- 「保持期間＋最大24時間」生き残るので、raw_retention_days=1 でも最大2日分が乗る。
-- 実測（2026-09-10）: 日次流入 raw 262.5MB / resumes 52.1MB、合計は 945MB まで膨らんでいた。
--   毎日1回  raw 525MB + resumes 417MB = 945MB（1GB枠の95%）
--   6時間ごと raw 328MB + resumes 378MB = 706MB（71%）
--   毎時     raw 273MB + resumes 367MB = 640MB（64%）  ← これにする
-- 毎時にしても Edge 呼び出しは月+720回で、Free枠50万に対して誤差。
-- 保持ポリシー（storage_retention_days=7 / raw_retention_days=1）は変えない。
-- 経歴書を短くすると、人材が一覧に残っているのにリンクだけ切れて営業が困るため。
--
-- ジョブ名は 'cleanup-storage-daily' のまま。付け直すと command に service_role key を
-- 書く必要があり、鍵をリポジトリやコマンドラインに置くことになる。schedule だけ差し替える。

SELECT cron.alter_job(jobid, schedule => '0 * * * *')
FROM cron.job
WHERE jobname = 'cleanup-storage-daily';

SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'cleanup-storage-daily';
