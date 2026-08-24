-- 通知タブに残っているエラー表示を消す（2026-08-18）
-- 2026-08-18 の差出人名テスト（from 指定 → 403 ErrorSendAsDenied）の記録。
-- コードは元に戻してデプロイ済みで、現行版では発生しない。
UPDATE app_config SET value = '""'::json WHERE key = 'notify_last_error';

SELECT key, value::text AS value FROM app_config WHERE key = 'notify_last_error';
