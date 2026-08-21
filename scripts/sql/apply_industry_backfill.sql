-- 既存人材の業界（raw_profile.industries）を貼り直す（2026-08-21）
--
-- 背景: 業界判定が「1回でも出たら全部付ける」だったうえ、裸の一般語（大学・通信・
--       公共・広告・HR・メーカー）を拾っていた。実測（prod 2,077人）:
--         教育 824人付与のうち684人(83%)は**学歴欄の「大学」だけ**が根拠
--         通信 840人付与のうち548人(65%)は裸の「通信」だけ
--       結果、1人あたり平均3.0業界・最大12業界（全14中）で、絞り込みにも表示にも
--       使えない状態だった。取り込み側（inbound-email の PROSE_INDUSTRIES）は
--       2026-08-21 に修正済みだが、**既に登録済みの行は焼き込み済みで直らない**。
--
-- 業界は本文＋添付テキストだけから決まるので、メールを取り直さずSQLで再計算できる。
-- 判定・並び順・上限は index.ts の PROSE_INDUSTRIES / INDUSTRY_MAX と同じ:
--   ・出現回数（20回で頭打ち）の多い順、同点は定義順
--   ・上位4件だけ残す
--
-- ⚠ 本番データのUPDATE。実行前に必ず dry-run（末尾の SELECT）で差分を確認すること。
-- 実行: supabase db query --linked -f scripts/sql/apply_industry_backfill.sql

BEGIN;

CREATE TEMP TABLE industry_new AS
WITH pat(ord, label, re) AS (VALUES
  ( 1,'金融',           '金融機関|銀行|証券会社|証券系|保険会社|生命?保険|損害?保険|信用金庫|信託銀行|FinTech|フィンテック|金融業界|金融系|勘定系'),
  ( 2,'医療・ヘルスケア','医療機関|ヘルスケア|病院|クリニック|製薬|医薬品|MedTech|医療業界|電子カルテ'),
  ( 3,'製造',           '製造業|(電機|電気|自動車|精密|化学|食品|部品|重工|機器|半導体|産業機械)メーカー|メーカー系|大手メーカー|プラント|工場(?!勤務|常駐|地域|長)|IoT分野|FAシステム|自動車業界|電気業界|製造業界|生産管理システム'),
  ( 4,'EC・物流',       '(^|[^A-Z])EC(?![A-Z])|イーコマース|eコマース|電子商取引|物流(?!倉庫担当)|運送業|商社'),
  ( 5,'小売・流通',     '小売(業)?|流通(業)?|リテール|百貨店|スーパー|コンビニ'),
  ( 6,'通信',           '通信業界|通信業|通信会社|通信キャリア|通信事業者?|通信機器メーカー|テレコム|移動体通信|携帯キャリア|キャリア(各社|系)'),
  ( 7,'ゲーム・エンタメ','ゲーム業界|エンタメ|エンターテインメント|メディア業界|動画配信|配信プラットフォーム'),
  ( 8,'不動産・建設',   '不動産|建設業界|建設業|建設会社|建設系|ゼネコン|住宅メーカー|住宅設備|注文住宅|プロパティ|デベロッパー'),
  ( 9,'公共・官公庁',   '官公庁|自治体|公共(系|分野|事業|機関|団体|案件|向け)|行政|省庁|外務省|区役所|市役所|県庁|地方公共団体'),
  (10,'教育',           '教育機関|学校法人|学習塾|EdTech|eLearning|教育業界|学校教育|大学(向け|法人|事務|生協|システム)|文教(系|分野|向け)?'),
  (11,'SES・SI',        'SES(?![A-Z])|受託開発|SIer|SI(?!P|[A-Z])|システムインテグレーション'),
  (12,'スタートアップ', 'スタートアップ|ベンチャー(企業)?'),
  (13,'人材・HR',       '人材業界|人材業|人材サービス|人材ビジネス|HRTech|HR系|採用プラットフォーム|採用マーケット'),
  (14,'マーケティング', 'マーケティング(業界|職|支援|部|会社)|広告代理店|広告業界|デジタルマーケ|アドテク')
), c AS (
  SELECT id,
         coalesce(raw_profile->'industries','[]'::jsonb) AS old_ind,
         coalesce(raw_profile->>'text','') || E'\n' || coalesce(raw_profile->>'attachmentText','') AS t
  FROM candidates WHERE data_env='prod' AND merged_into IS NULL
), hits AS (
  SELECT c.id, p.label, p.ord, n.n
  FROM c CROSS JOIN pat p
  CROSS JOIN LATERAL (SELECT least(regexp_count(c.t, p.re), 20) AS n) n
  WHERE n.n > 0
), ranked AS (
  SELECT id, label, n, ord,
         row_number() OVER (PARTITION BY id ORDER BY n DESC, ord) AS rn
  FROM hits
)
SELECT c.id,
       c.old_ind,
       coalesce((SELECT jsonb_agg(to_jsonb(r.label) ORDER BY r.rn)
                 FROM ranked r WHERE r.id = c.id AND r.rn <= 4), '[]'::jsonb) AS new_ind,
       -- 根拠（出現回数）も残す。取り込み側の _industryScores と同じ意味
       coalesce((SELECT jsonb_object_agg(r.label, r.n)
                 FROM ranked r WHERE r.id = c.id), '{}'::jsonb) AS scores
FROM c;

-- ① 適用前の差分サマリー
SELECT count(*)                                              AS 対象人数,
       count(*) FILTER (WHERE old_ind <> new_ind)            AS 変わる人数,
       round(avg(jsonb_array_length(old_ind))::numeric,2)    AS 旧_平均件数,
       round(avg(jsonb_array_length(new_ind))::numeric,2)    AS 新_平均件数,
       max(jsonb_array_length(old_ind))                      AS 旧_最大,
       max(jsonb_array_length(new_ind))                      AS 新_最大,
       count(*) FILTER (WHERE jsonb_array_length(old_ind)=0) AS 旧_0件,
       count(*) FILTER (WHERE jsonb_array_length(new_ind)=0) AS 新_0件
FROM industry_new;

-- ② 貼り直し
UPDATE candidates c
SET raw_profile = jsonb_set(
      jsonb_set(c.raw_profile, '{industries}', n.new_ind, true),
      '{_industryScores}', n.scores, true)
FROM industry_new n
WHERE c.id = n.id AND n.old_ind IS DISTINCT FROM n.new_ind;

-- ③ 適用後の確認（②で書いた値が読めるか）
SELECT round(avg(jsonb_array_length(raw_profile->'industries'))::numeric,2) AS 適用後_平均件数,
       max(jsonb_array_length(raw_profile->'industries'))                   AS 適用後_最大,
       count(*) FILTER (WHERE raw_profile->'industries' ? '教育')           AS 適用後_教育,
       count(*) FILTER (WHERE raw_profile->'industries' ? '通信')           AS 適用後_通信
FROM candidates WHERE data_env='prod' AND merged_into IS NULL;

COMMIT;
