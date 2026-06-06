-- agent_companies: 派遣・紹介会社情報テーブル
-- domain をPKとしてメールドメインで一意管理
CREATE TABLE IF NOT EXISTS agent_companies (
  domain            text PRIMARY KEY,          -- メールドメイン（例: abc-hr.co.jp）
  company_name      text,                       -- 会社名（メール署名から抽出）
  haken_number      text,                       -- 労働者派遣事業許可番号（例: 派13-XXXXXX）
  shokai_number     text,                       -- 有料職業紹介事業許可番号（例: 13-ユXXXXXX）
  license_status    text NOT NULL DEFAULT 'unknown'  -- unknown / haken / shokai / both / none
                    CHECK (license_status IN ('unknown','haken','shokai','both','none')),
  verified_at       timestamptz,                -- 厚労省サイトで確認した日時
  verified_by       text,                       -- 確認者（'cron' or ニックネーム）
  source            text NOT NULL DEFAULT 'email'  -- 情報ソース（email / manual）
                    CHECK (source IN ('email','manual')),
  memo              text,                       -- 手動メモ
  first_seen_at     timestamptz NOT NULL DEFAULT now(),  -- 初回登録日時
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- RLS: 認証不要（service_role でのみ書き込む想定）
ALTER TABLE agent_companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_companies_select_all" ON agent_companies FOR SELECT USING (true);
CREATE POLICY "agent_companies_insert_service" ON agent_companies FOR INSERT WITH CHECK (true);
CREATE POLICY "agent_companies_update_service" ON agent_companies FOR UPDATE USING (true);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_agent_companies_status ON agent_companies(license_status);
CREATE INDEX IF NOT EXISTS idx_agent_companies_verified ON agent_companies(verified_at) WHERE verified_at IS NULL;

-- updated_at 自動更新トリガ
CREATE OR REPLACE FUNCTION update_agent_companies_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_companies_updated_at ON agent_companies;
CREATE TRIGGER agent_companies_updated_at
  BEFORE UPDATE ON agent_companies
  FOR EACH ROW EXECUTE FUNCTION update_agent_companies_updated_at();

-- ===== 一括バッチ登録（既存DBデータから会社名・ドメインを抽出） =====
-- ai_logs.raw_body（メール本文先頭3000文字）+ candidates.raw_profile から抽出
-- NOTE: このクエリは一回限り実行用。重複は ON CONFLICT DO NOTHING で無視

-- 1. ai_logs から送信元ドメインと会社名を取得
WITH email_sources AS (
  -- candidates の raw_profile から from アドレスとメール本文を取得
  SELECT
    raw_profile->>'from'    AS from_addr,
    raw_profile->>'text'    AS body_text
  FROM candidates
  WHERE data_env = 'prod'
    AND raw_profile->>'from' IS NOT NULL
    AND raw_profile->>'from' NOT ILIKE '%@demo.invalid%'
    AND raw_profile->>'from' NOT ILIKE '%@outlook.jp%'
    AND raw_profile->>'from' NOT ILIKE '%@i-voice.co.jp%'
),
-- ドメイン抽出（@以降）
with_domain AS (
  SELECT
    LOWER(TRIM(SPLIT_PART(from_addr, '@', 2))) AS domain,
    body_text
  FROM email_sources
  WHERE from_addr LIKE '%@%'
    AND SPLIT_PART(from_addr, '@', 2) != ''
),
-- 会社名抽出: 株式会社・合同会社・有限会社・一般社団法人 パターン
with_company AS (
  SELECT
    domain,
    (REGEXP_MATCHES(
      body_text,
      '(?:株式会社|合同会社|有限会社|一般社団法人|一般財団法人|合名会社|協同組合)[^\s　\n\r、。！？]{2,30}|[^\s　\n\r、。]{2,30}(?:株式会社|合同会社|有限会社)',
      'g'
    ))[1] AS company_name
  FROM with_domain
  WHERE body_text IS NOT NULL
),
-- ドメインごとに最頻出の会社名を選択
ranked AS (
  SELECT
    domain,
    company_name,
    COUNT(*) AS cnt,
    ROW_NUMBER() OVER (PARTITION BY domain ORDER BY COUNT(*) DESC) AS rn
  FROM with_company
  WHERE company_name IS NOT NULL
    AND LENGTH(company_name) >= 4
  GROUP BY domain, company_name
),
best_names AS (
  SELECT domain, company_name
  FROM ranked
  WHERE rn = 1
),
-- ドメイン一覧（会社名なしでも登録）
all_domains AS (
  SELECT DISTINCT domain FROM with_domain WHERE domain NOT ILIKE '%.gmail.com' AND domain NOT ILIKE '%.yahoo%'
)
INSERT INTO agent_companies (domain, company_name, source, first_seen_at)
SELECT
  ad.domain,
  bn.company_name,
  'email',
  now()
FROM all_domains ad
LEFT JOIN best_names bn ON ad.domain = bn.domain
WHERE ad.domain != ''
  AND ad.domain NOT LIKE '%localhost%'
  AND LENGTH(ad.domain) >= 4
ON CONFLICT (domain) DO UPDATE
  SET company_name = COALESCE(EXCLUDED.company_name, agent_companies.company_name),
      updated_at = now();

-- 登録件数確認
SELECT COUNT(*) AS total_companies,
       SUM(CASE WHEN company_name IS NOT NULL THEN 1 ELSE 0 END) AS with_name,
       SUM(CASE WHEN company_name IS NULL THEN 1 ELSE 0 END) AS without_name
FROM agent_companies;
