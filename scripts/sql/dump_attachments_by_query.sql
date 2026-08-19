-- 添付ダンプモード: 指定した件名のメールから添付を Storage に救出する（2026-08-19）
--
-- 用途:
--   人への割り当てに失敗した添付は resume_url が付かず、バイト列がどこにも残らない。
--   台帳(ai_logs.type='poll-attach')にはファイル名・サイズしか無いため、
--   「なぜそう解析されたか」を後から再現できない。このモードで実物を取り戻す。
--
-- 探索範囲（poll-email/index.ts:946）:
--   inbox → deleteditems → recoverableitemsdeletions
--   3つ目は削除済みアイテムを空にした後も14〜30日残る領域。
--
-- 副作用なし: 候補者は作らない・既読化しない・削除しない。実行後は自動で incremental に戻る。
--
-- 実行: npx supabase db query --linked -f scripts/sql/dump_attachments_by_query.sql
-- 結果: Storage の dump/<メールID>/att0_0.xlsx
--       ai_logs の type='dump-attach' に元ファイル名と公開URL

-- 探したい件名（部分一致）。value は json 型なのでダブルクォートで囲む
UPDATE app_config SET value = '"【直人材のご紹介】Java"' WHERE key = 'email_dump_query';
UPDATE app_config SET value = '"dumpatt"'                WHERE key = 'email_poll_mode';

SELECT key, value FROM app_config WHERE key IN ('email_dump_query','email_poll_mode');

-- ── 後片付け（PIIを残さない） ─────────────────────────────
-- 調査が終わったら dump/ 配下の実ファイルを消すこと:
--   UPDATE app_config SET value = '"__cleanup__"' WHERE key = 'email_dump_query';
--   UPDATE app_config SET value = '"dumpatt"'     WHERE key = 'email_poll_mode';
