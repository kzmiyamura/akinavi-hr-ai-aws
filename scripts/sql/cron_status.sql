-- 登録されている cron と、直近の実行結果を確認する（読み取りのみ）。
-- 「migration は書いたが本番に適用されていない」「登録済みだが失敗し続けている」を切り分ける
select jobid, jobname, schedule, active from cron.job order by jobname;
