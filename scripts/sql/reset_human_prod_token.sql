-- prod人材のGraphトークンを空にして Secret へフォールバックさせる（2026-08-18）
--
-- 背景:
--   notify-candidates は poll-email と同じ app_config キー 'graph_rt_human_prod' を
--   使い、リフレッシュ時にそこへ書き戻す（notify-candidates/index.ts:16,65）。
--   8/17 に通知(Mail.Send)の再同意を個人アカウント kzmiyamura@gmail.com で行った際、
--   このキーが個人アカウントのトークンで上書きされた。
--   以降 poll-email は個人メールボックスを巡回し、未読0件・エラー0件を返し続けている
--   （本来の巡回先は akinavi.hr.ai.voice.human@outlook.jp）。
--
-- 狙い:
--   poll-email は app_config の値が空なら Supabase Secret の
--   GRAPH_REFRESH_TOKEN_HUMAN にフォールバックする（poll-email/index.ts:391-401）。
--   上書き前の正しいトークンが Secret に残っていれば、ブラウザ再同意なしで復旧する。
--
-- 失敗時:
--   Secret 側が失効していれば invalid_grant になる。その場合は設定画面から
--   akinavi.hr.ai.voice.human@outlook.jp で再連携する（要ブラウザのサインアウト）。
--   元の値はローカルにバックアップ済み（下部の復旧手順を参照）。
--
-- 実行: npx supabase db query --linked -f scripts/sql/reset_human_prod_token.sql

-- value は json 型。空文字リテラルは不正なJSONで弾かれるため JSON の空文字 '""' を入れる。
-- supabase-js 側では空文字（falsy）として読まれ、Secret へのフォールバックが働く。
UPDATE app_config
   SET value = '""'
 WHERE key = 'graph_rt_human_prod';

-- 結果確認（トークンは出さず長さだけ見る）
SELECT key, length(value::text) AS value_len, updated_at
  FROM app_config
 WHERE key = 'graph_rt_human_prod';

-- ── 復旧（元に戻す場合） ─────────────────────────────
-- 元の値はリポジトリに置いていない（リフレッシュトークンのため）。
-- バックアップ: scratchpad/graph_rt_human_prod.backup.json
--   UPDATE app_config SET value = '"<バックアップのvalue>"' WHERE key = 'graph_rt_human_prod';
--   （json型なのでダブルクォートで囲んだJSON文字列として入れる）
