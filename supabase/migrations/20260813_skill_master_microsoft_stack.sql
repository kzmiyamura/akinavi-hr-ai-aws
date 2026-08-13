-- Microsoft スタックの表記ゆれ・改称・包含関係を skill_master / skill_implications に入れる。
--
-- 2026-08-13、営業から次の指摘があった:
--   「この案件（PowerShell → Azure Functions 移行）は Windows / Azure / M365 といった
--     Microsoft 知識全般を問うている。単語一致だけでは拾えない」
--
-- 実際に調べたところ、LLM を持ち出すまでもないデータの欠落だった:
--   ・EntraID が skill_master に**存在しない**。案件の必須スキルに書かれているのに
--     マスタに無いので、表記が完全に一致する人材しか当たらない
--   ・Azure AD は 2023年に Microsoft Entra ID へ**改称**された。経歴書には
--     「Azure AD」「Azure Active Directory」と書かれていることが圧倒的に多いが、
--     改称の事実が入っていないため EntraID 要件と永久に結びつかない
--   ・GraphAPI（案件本文にある）が M365 操作の知識と結びついていない
--
-- 判定ロジックは変えない。skill_satisfies が使う辞書に事実を足すだけ。

-- ① Entra ID（旧 Azure AD）
--
-- 【やってはいけないこと】新しく 'EntraID' という行を作ること。
-- 既存の 'Azure Active Directory' 行が別名に "Entra ID" を持っており、
-- 案件の必須スキル "EntraID" は空白除去でそこに解決していた。
-- 別行を作ると canon('EntraID') が新しい行を指し、
-- 「Azure Active Directory」を持つ28人との繋がりが切れる（実測 28人 → 1人）。
-- 正しくは**既存行の別名を増やす**。
UPDATE skill_master
   SET aliases = '["AAD","azure ad","Azure AD","AzureAD","Entra ID","EntraID","Microsoft Entra ID","Entra ID (Azure AD)"]'::jsonb
 WHERE name = 'Azure Active Directory';

-- 取り違えて作ってしまった行があれば消す（再実行できるように）
DELETE FROM skill_master WHERE name = 'EntraID';

-- ② Microsoft Graph（案件本文の「GraphAPI」）
INSERT INTO skill_master (name, category, aliases)
VALUES (
  'Microsoft Graph', 'clouds',
  '["Graph API","GraphAPI","MS Graph","Microsoft Graph API","Graph"]'::jsonb
)
ON CONFLICT (name) DO UPDATE
  SET aliases = EXCLUDED.aliases, category = EXCLUDED.category;

-- ③ PowerShell の実行形態の表記ゆれ（案件は「PowerShell Core で動作させる」と書いている）
UPDATE skill_master
   SET aliases = '["powershell","ps1","PowerShell Core","pwsh","Windows PowerShell","PowerShell7","PowerShell 7"]'::jsonb
 WHERE name = 'PowerShell';

-- ④ 包含関係（child を持つ人は parent の要件を満たす。向きがある）
--    緩めすぎると「C が Microsoft 365 に一致」の二の舞になるので、
--    製品として明確に内包する関係だけに絞る。
INSERT INTO skill_implications (child, parent) VALUES
  ('azure functions', 'azure'),          -- Azure Functions を使う＝Azure を触っている
  ('microsoft graph', 'microsoft 365'),  -- Graph は M365 テナントを操作するAPI
  ('azure active directory', 'microsoft 365') -- Entra ID(旧Azure AD) は M365 の ID 基盤
ON CONFLICT DO NOTHING;

-- skill_master を触ったら正規化辞書を貼り直す
REFRESH MATERIALIZED VIEW skill_norm_map;
