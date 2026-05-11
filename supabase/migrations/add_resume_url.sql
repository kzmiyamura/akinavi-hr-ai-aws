-- candidatesテーブルに経歴書URL・単価・送信元会社名カラムを追加
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS resume_url   text,   -- 経歴書の主URL（Drive or Box）
  ADD COLUMN IF NOT EXISTS drive_url    text,   -- Google Drive URL（box-downloader転送後）
  ADD COLUMN IF NOT EXISTS desired_rate text,   -- 希望単価（例: "60万円/月"）
  ADD COLUMN IF NOT EXISTS from_company text;   -- 送信元会社名（紹介会社）

COMMENT ON COLUMN candidates.resume_url   IS '経歴書の主URL（メール添付→Drive / DriveリンクURL）';
COMMENT ON COLUMN candidates.drive_url    IS 'Google Drive URL（box-downloader転送後に設定）';
COMMENT ON COLUMN candidates.desired_rate IS '希望単価（例: "60万円/月"）';
COMMENT ON COLUMN candidates.from_company IS '紹介元会社名（送信者メールドメインまたはAI抽出）';
