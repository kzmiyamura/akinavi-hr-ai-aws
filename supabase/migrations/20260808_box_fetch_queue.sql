-- Box経歴書ワンクリック再解析キュー（2026-08-08）
-- box_status に取得キュー用の状態を追加:
--   pending         Box URLあり・未処理（従来）
--   fetch_requested UIのボタンで取得を依頼（ThinkCentreワーカーが拾う）
--   fetching        ワーカーがダウンロード・解析中
--   enriched        取り込み・再解析済み（従来）
--   failed          失敗（従来。ボタンで再依頼可能）
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_box_status_check;
ALTER TABLE candidates ADD CONSTRAINT candidates_box_status_check
  CHECK (box_status IN ('pending', 'fetch_requested', 'fetching', 'enriched', 'failed'));

-- ワーカーのキュー検索用
CREATE INDEX IF NOT EXISTS candidates_box_fetch_queue_idx
  ON candidates (box_status)
  WHERE box_status IN ('fetch_requested', 'fetching');

COMMENT ON COLUMN candidates.box_status IS
  'Box連携状態: pending=未処理 / fetch_requested=取得依頼(UI) / fetching=ワーカー処理中 / enriched=取り込み済み / failed=失敗';
