-- Supabase Storage: attachments バケット作成（経歴書・添付ファイル保存用）
INSERT INTO storage.buckets (id, name, public)
VALUES ('attachments', 'attachments', true)
ON CONFLICT (id) DO NOTHING;

-- 公開読み取りポリシー（誰でもダウンロード可）
CREATE POLICY "Public read attachments"
ON storage.objects FOR SELECT
USING (bucket_id = 'attachments');

-- サービスロールによるアップロードポリシー
CREATE POLICY "Service role upload attachments"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'attachments');
