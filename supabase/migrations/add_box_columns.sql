-- candidatesテーブルにBox連携用カラムを追加
-- box_url  : メール本文から抽出したBox共有URL（例: https://app.box.com/s/xxxx）
-- box_status: pending（未処理）/ enriched（Drive取得・再解析済み）/ failed（失敗）

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS box_url    text,
  ADD COLUMN IF NOT EXISTS box_status text CHECK (box_status IN ('pending', 'enriched', 'failed'));

-- box_statusが 'pending' の人材を高速検索するためのインデックス
CREATE INDEX IF NOT EXISTS candidates_box_status_idx
  ON candidates (box_status)
  WHERE box_status = 'pending';

COMMENT ON COLUMN candidates.box_url    IS 'メール本文から抽出したBox共有URL';
COMMENT ON COLUMN candidates.box_status IS 'Box連携状態: pending=未処理 / enriched=Drive取得・再解析済み / failed=失敗';
