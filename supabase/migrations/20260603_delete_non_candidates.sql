-- 非人材メール混入レコードの削除（品質チェック 2026-06-03 検出）
-- NDAメール・派遣更新連絡・rightarm案件条件メール・sanei-system案件メール

DELETE FROM candidates
WHERE id IN (
  '881d4e4d-03ca-4b78-a9ec-78dc71cb638b', -- NDAメール（kaopiz.com / 情報交換のご相談）
  'fbab1e35-cc9a-4f1d-9a9a-ea0927543b7d', -- 派遣更新連絡（mail.toshiba）
  '6bf4ba4c-f495-4610-9b4e-a88c4545042c', -- 派遣更新連絡（mail.toshiba）
  '3c0d164b-3a64-4cd3-ba4d-6ad208a87042', -- 案件条件メール（rightarm.co.jp / VB.Net ~55万）
  '68a5c3d0-3733-41a8-aa44-428fa9b7ebb4', -- 案件条件メール（rightarm.co.jp / COBOL ~60万）
  '274cda34-8de0-40f8-9252-5292a5ebbcb2', -- 案件条件メール（rightarm.co.jp）
  '38e9b5ce-bd90-410a-b813-419b1ab726d7', -- 案件条件メール（rightarm.co.jp）
  'b1142ae9-1e78-4c3c-b4ef-89d049f5d837', -- 案件条件メール（rightarm.co.jp）
  '1662e868-2383-4395-add4-ed168e6ef0b2', -- 案件条件メール（rightarm.co.jp）
  'fb27769d-f326-4b13-acd1-e000a9d4e58a'  -- 案件紹介メール（sanei-system.co.jp / 物流システム開発）
)
AND data_env = 'prod';
