-- notify-candidates の cron を登録する（2026-08-17）。
--
-- 背景: supabase/migrations/add_notify_cron.sql が YOUR_PROJECT_REF のままで
-- 一度も適用されておらず、通知機能が7/23のデプロイ以降まったく動いていなかった。
--
-- ⚠ service_role キーをこのファイルにもコマンドラインにも書かない。
--    既に動いている poll-email のジョブ定義から Authorization ヘッダをそのまま引き継ぐ。
--    （承認ダイアログの履歴やリポジトリに鍵が平文で残るのを避けるため）
--
-- 実行: npx supabase db query --linked -f scripts/sql/apply_notify_cron.sql
-- 間隔: 毎時0分（2026-08-17 ユーザー判断。関数側の探索窓は最大24時間なので取りこぼさない）

DO $$
DECLARE
  auth_header text;
  fn_url text := 'https://argizomylbolpqxgmvim.supabase.co/functions/v1/notify-candidates';
  cmd text;
BEGIN
  SELECT (regexp_match(command, '"Authorization"\s*:\s*"(Bearer [^"]+)"'))[1]
    INTO auth_header
    FROM cron.job
   WHERE jobname = 'poll-email-every-5-minutes';

  IF auth_header IS NULL THEN
    RAISE EXCEPTION '既存の poll-email ジョブから Authorization ヘッダを取得できませんでした。手動で登録してください。';
  END IF;

  cmd := format(
    $f$SELECT net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb)$f$,
    fn_url,
    json_build_object('Content-Type', 'application/json', 'Authorization', auth_header)::text
  );

  PERFORM cron.schedule('notify-candidates-hourly', '0 * * * *', cmd);
END $$;

-- 登録結果の確認（鍵は伏せて表示する）
SELECT jobid::text AS jobid, jobname, schedule, active::text AS active,
       regexp_replace(command, 'Bearer [^"]+', 'Bearer ***') AS command
FROM cron.job
WHERE jobname = 'notify-candidates-hourly';
