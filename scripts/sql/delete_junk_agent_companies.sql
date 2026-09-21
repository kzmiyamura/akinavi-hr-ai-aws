-- ============================================================================
-- フィッシング送信元を agent_companies から消す（2026-09-21・ユーザー承認のうえ実行）
-- ============================================================================
-- 画面に「Amazon.com, Inc.」が派遣・紹介会社として3社並んでいた（ユーザー指摘）。
-- 送信元は mail17.hytjy.com / mail08.hytjy.com / mail03.wxyysb.com という
-- フィッシングのドメインで、いずれも人材は1人・経歴書0%・自社0%。
--
-- ⚠ **ドメインを1つずつ明示して消す。条件式で消さない。**
--    最初「今いる人材が全員『人ではない』」を条件にしようとしたが、その中には
--    株式会社SRA・キーウェアソリューションズ・株式会社システムフロー・博士ドットコム
--    といった**実在の取引先**が入っていた。たまたま今あるレコードが人ではなかっただけ。
--    条件で消していたら本物の取引先を失っていた。
--
-- ⚠ lelouptokyo.com / Sansan, Inc. は社名とドメインが食い違うが、Sansan は実在企業で
--    判断がつかないため**残す**。疑わしいだけでは消さない。
--
-- 再発防止は inbound-email 側で実施済み（2026-09-21）:
--   ・単独人材: NO_PERSON_FOUND が agent_companies の upsert より前で止める
--   ・複数人材: results.length > 0（1人でも登録できたとき）だけ upsert する
-- ============================================================================

with target(domain) as (
  values
    ('mail17.hytjy.com'),        -- Amazon.com, Inc. を騙る
    ('mail08.hytjy.com'),        -- Amazon.com, Inc. を騙る
    ('mail03.wxyysb.com'),       -- Amazon.com, Inc. を騙る
    ('mail11.qimeihulian.com'),  -- 株式会社セブン・カードサービス発行 を騙る（MyJCB フィッシング）
    ('inaryo.com'),              -- WADAX GMO, Inc. を騙る
    ('j-shiyaku.or.jp'),         -- WADAX GMO, Inc. を騙る
    ('escalator.qcnhy.com')      -- 株式会社三井住友銀行 を騙る
),
deleted as (
  delete from public.agent_companies a
  using target t
  where a.domain = t.domain
  returning a.domain, a.company_name
)
select
  (select count(*) from deleted) as 削除した社数,
  (select string_agg(domain || '（' || coalesce(company_name,'名前なし') || '）', ' / ') from deleted) as 削除した内訳,
  (select count(*) from public.agent_companies) as 残りの社数;
