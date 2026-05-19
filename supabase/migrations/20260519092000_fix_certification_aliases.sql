-- certification aliases バグ修正
-- IPA試験の2文字コード（FE/AP/DB/NW/SC/SA/SM/ST/ES/AU）が
-- メール本文中の無関係な略語（「FEとBE担当」「DBを使って開発」等）に
-- 誤マッチして間違った資格タグが付く問題を修正する。
-- aliases カラムは jsonb 型のため jsonb_array_elements_text で処理する。

-- 汎用ヘルパー: jsonb配列から特定の文字列値を除去する
CREATE OR REPLACE FUNCTION jsonb_array_remove_val(arr jsonb, val text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT jsonb_agg(v)
     FROM jsonb_array_elements_text(COALESCE(arr, '[]'::jsonb)) t(v)
     WHERE v != val),
    '[]'::jsonb
  )
$$;

-- 基本情報技術者: FE を削除（「FEとBE担当」「FE開発」等で誤マッチ）
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'FE')
WHERE name = '基本情報技術者' AND category = 'certifications';

-- 応用情報技術者: AP を削除（「APサーバー管理」等で誤マッチ）
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'AP')
WHERE name = '応用情報技術者' AND category = 'certifications';

-- データベーススペシャリスト: DB を削除（「DBを使って開発」等で誤マッチ）
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'DB')
WHERE name = 'データベーススペシャリスト' AND category = 'certifications';

-- ネットワークスペシャリスト: NW を削除（「NW構成」「NW設計」等で誤マッチ）
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'NW')
WHERE name = 'ネットワークスペシャリスト' AND category = 'certifications';

-- 情報処理安全確保支援士: SC, セキュリティ試験 を削除
UPDATE skill_master SET aliases =
  jsonb_array_remove_val(jsonb_array_remove_val(aliases, 'SC'), 'セキュリティ試験')
WHERE name = '情報処理安全確保支援士' AND category = 'certifications';

-- システムアーキテクト: SA を削除（「SAとPOの役割」等で誤マッチ）
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'SA')
WHERE name = 'システムアーキテクト' AND category = 'certifications';

-- SAFe認定: SA を削除
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'SA')
WHERE name = 'SAFe認定' AND category = 'certifications';

-- ITサービスマネージャ: SM を削除
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'SM')
WHERE name = 'ITサービスマネージャ' AND category = 'certifications';

-- ITストラテジスト: ST を削除
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'ST')
WHERE name = 'ITストラテジスト' AND category = 'certifications';

-- エンベデッドシステムスペシャリスト: ES（ECMAScript/Elasticsearchの略と衝突）, 組込みシステム を削除
UPDATE skill_master SET aliases =
  jsonb_array_remove_val(jsonb_array_remove_val(aliases, 'ES'), '組込みシステム')
WHERE name = 'エンベデッドシステムスペシャリスト' AND category = 'certifications';

-- システム監査技術者: AU を削除
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, 'AU')
WHERE name = 'システム監査技術者' AND category = 'certifications';

-- TOEIC 800点以上: 英語力 を削除（「英語力: ビジネスレベル」でTOEIC800点以上に誤タグ）
UPDATE skill_master SET aliases = jsonb_array_remove_val(aliases, '英語力')
WHERE name = 'TOEIC 800点以上' AND category = 'certifications';
