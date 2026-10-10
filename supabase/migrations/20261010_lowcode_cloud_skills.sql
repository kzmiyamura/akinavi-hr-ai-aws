-- 「ローコード開発」「クラウド上での開発」と書かれた案件を人材に結びつける（Issue #189・2026-10-10）
--
-- ■ 報告（営業）
--   ・「ローコード開発」と記載した時に、例えば PowerApps の経験がある人をマッチングさせてほしい
--   ・「クラウド上での開発」と記載した時に、AWS や Azure 上での開発経験をマッチングしてほしい
--
-- ■ なぜ今は当たらないのか（ローカル控え 9,014人で実測。prod は引いていない）
--   ① `skill_master` に「ローコード開発」「クラウド開発」という**正式名が無い**。
--      案件側の要件文字列が正規化されないので、別名（「クラウド上での開発」等）で
--      書かれても同じ要件として扱えない
--   ② 判定③の語境界一致しか残らないが、**「ローコード」と書いている人材は0人**、
--      「クラウド開発」と書いている人材も0人。つまり誰にも当たらない
--      （一方で Power Automate 340人 / Power Apps 125人 / AWS 4,821人 / Azure 1,893人 は居る）
--   ③ 包含関係（`skill_implications`）に クラウド・ローコードの向きが1本も無い
--
-- ■ 入れるもの（実測した人数を根拠に選ぶ）
--   ローコード開発 ← Power Apps / Power Automate     … 374人 (4.1%)
--   クラウド開発   ← `skill_master.category = 'clouds'` の95件 + 他カテゴリに居る
--                    クラウドのサービス4件             … 5,539人 (61.4%)
--
--   **入れなかったもの（測った上で捨てた）**
--   ・kintone / OutSystems / Mendix / AppSheet / Claris FileMaker / Oracle APEX / Power Pages
--     … 控えの 9,014人で**全部0人**。`skill_master` に足しても誰にも効かない行が増えるだけ
--       （夜間健診の検出器①「使われない機械」が鳴る類）。実際に書く人が現れたら足す
--   ・Salesforce (689人) / ServiceNow (336人) → ローコード開発
--     … 合わせて最大961人(10.7%)動く。Salesforce の設定・ServiceNow の ITSM 運用は
--       「ローコードで開発した」と言い切れないので、**営業判断を待つ**。
--       入れるなら下の INSERT に2行足すだけ
--
-- ■ 「クラウド開発」は汎用スキルにする（61.4% が該当する）
--   `20260813_generic_skills.sql` の基準（分類が methodologies / others かつ充足率40%以上）に
--   そのまま当てはまる。汎用にすると**それ単独では候補資格にならない**が、
--   **配点では従来どおり加点される**ので、
--     ・案件が [C#, クラウド上での開発] … 資格は C# で判定し、クラウド経験者が上に来る
--     ・案件が [クラウド上での開発] だけ … `selective_skills` が全部汎用のとき元の配列を
--                                          返すので、クラウド経験者が候補になる
--   という両方が成り立つ。Issue #188（経験が無い人が1位になる）を悪化させない形。
--   ローコード開発は 4.1% なので汎用にしない（立派な絞り込みになる）。
--
-- ■ あわせて直す: `selective_skills` が別名を見ていなかった
--   `lower(trim(m.name)) = lower(trim(s))` で**正式名の完全一致**しか見ておらず、
--   案件に別名で書かれた汎用スキル（「クラウド上での開発」「結合テスト」等）が
--   汎用と判定されずに資格判定へ残っていた。`skill_canon()` を通して直す。
--   これは今回の変更が別名経由で入ってくるため**避けて通れない**（別名で書かれた
--   「クラウド上での開発」だけが汎用扱いを素通りし、クラウド経験者だけで資格が決まる）。

-- ============================================================
-- 1. 要件側の正式名を作る（別名で表記ゆれを吸収する）
-- ============================================================
-- ⚠ 既にある行には触らない。skill_master は**既存行を編集する**のが鉄則で、
--   同じ意味の行を新しく作ると正式名を奪って一致が壊れる（実績: 該当者が28人→1人）。
--   name に一意制約があるので ON CONFLICT DO NOTHING で素通りさせる。
--   別名が既存行に取られていないかは、このファイル最後の確認クエリで見る。
INSERT INTO skill_master (id, name, category, aliases, source, is_generic) VALUES
  ('3f1a6c2e-7b84-4d19-9a53-2c8e7f5b1d40', 'ローコード開発', 'methodologies',
   '["ローコード","ローコード開発","ノーコード","ノーコード開発","ローコード/ノーコード","low-code","lowcode","low code","no-code","nocode","ローコードツール","ローコード開発ツール"]'::jsonb,
   'seed', false),
  ('5c93b7d1-4e26-48fa-8b07-9d41a6e2c358', 'クラウド開発', 'methodologies',
   '["クラウド上での開発","クラウド上の開発","クラウド開発","クラウド環境での開発","クラウドアプリ開発","クラウドアプリケーション開発","cloud development","クラウド上でのアプリ開発"]'::jsonb,
   -- 61.4%（控え9,014人で実測）が該当するので最初から汎用。理由は冒頭の説明を参照
   'seed', true)
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 2. 包含関係（child を持つ人は parent の要件も満たす）
-- ============================================================
-- child / parent は **lower(正式名)**。skill_norm_map の canon がこの形なので、
-- 空白を詰めたり別名で書いたりすると1行も効かない（skill_implications の既存行も
-- 'sql server' / 'oracle database' のように空白入りで入っている）。

-- ローコード: 実在する2つだけ。Power Apps 125人 / Power Automate 340人（重複を除いて374人）
INSERT INTO skill_implications (child, parent, note) VALUES
  ('power apps',     'ローコード開発', 'Microsoft Power Platform。控えで125人'),
  ('power automate', 'ローコード開発', 'Microsoft Power Platform。控えで340人')
ON CONFLICT (child, parent) DO NOTHING;

-- クラウド: 製品を手で列挙すると漏れるので `clouds` カテゴリを丸ごと子にする。
-- 新しいクラウド製品を skill_master に足したときは、この INSERT をもう一度流せば追いつく
-- （ON CONFLICT DO NOTHING なので何度流しても安全）。
INSERT INTO skill_implications (child, parent, note)
SELECT lower(m.name), 'クラウド開発', 'skill_master.category = clouds'
  FROM skill_master m
 WHERE m.category = 'clouds'
   AND trim(m.name) != ''
ON CONFLICT (child, parent) DO NOTHING;

-- clouds に入っていないがクラウドのサービスであるもの。
-- 控えの実測で「サービス名だけ書いてプラットフォーム名を書かない人」が58人居り、
-- その内訳がほぼこの4つだった（BigQuery / Amazon DynamoDB / Amazon S3）。
-- 包含関係は1段しか辿らない（skill_satisfies が child→parent を1回引くだけ）ので、
-- `azure functions → azure → クラウド開発` のような連鎖は効かない。だから直接入れる。
INSERT INTO skill_implications (child, parent, note) VALUES
  ('bigquery',        'クラウド開発', 'dwh カテゴリだがGCPのサービス。控えでサービス名のみ記載の人が居る'),
  ('google bigquery', 'クラウド開発', '同上'),
  ('dynamodb',        'クラウド開発', 'databases カテゴリだがAWSのサービス'),
  ('cloudformation',  'クラウド開発', 'infrastructures カテゴリだがAWSのサービス')
ON CONFLICT (child, parent) DO NOTHING;

-- ============================================================
-- 3. selective_skills を別名に対応させる
-- ============================================================
-- 変更点は1行（`lower(trim(m.name)) = lower(trim(s))` → `= skill_canon(s)`）。
-- canon は skill_master の**正式名（小文字）**なので左辺はそのまま比較できる。
CREATE OR REPLACE FUNCTION public.selective_skills(p_skills text[])
RETURNS text[]
LANGUAGE sql STABLE
AS $$
  WITH kept AS (
    SELECT s
      FROM unnest(COALESCE(p_skills, ARRAY[]::text[])) s
     WHERE NOT EXISTS (
       SELECT 1 FROM skill_master m
        WHERE m.is_generic
          -- ⚠ 正式名の完全一致では、案件に別名で書かれた汎用スキルを取り逃す
          --   （「クラウド上での開発」は「クラウド開発」の別名・2026-10-10）
          AND lower(trim(m.name)) = skill_canon(s)
     )
  )
  SELECT CASE WHEN (SELECT COUNT(*) FROM kept) = 0
              THEN p_skills
              ELSE ARRAY(SELECT s FROM kept) END
$$;

COMMENT ON FUNCTION public.selective_skills(text[]) IS
  '必須スキルから汎用スキル（誰でも持っている）を除いた配列。'
  '別名で書かれていても skill_canon() で正式名に寄せて判定する。'
  '全部が汎用なら元の配列をそのまま返す（候補が空になるのを防ぐ）';

-- ============================================================
-- 4. 確認（`supabase db query -f` は最後の文の結果だけを返す）
-- ============================================================
-- ・新しい別名が既存行に取られていないか（控えは 2026-09-28 のスナップショットなので、
--   それ以降に足された行と衝突していないかは本番で見るしかない）
-- ・包含関係が何本入ったか
SELECT
  skill_canon('ローコード')            AS "ローコードの正規化先",
  skill_canon('クラウド上での開発')    AS "クラウド上での開発の正規化先",
  skill_satisfies('Power Apps', 'ローコード開発')        AS "PowerApps→ローコード開発",
  skill_satisfies('AWS', 'クラウド上での開発')           AS "AWS→クラウド上での開発",
  skill_satisfies('Azure', 'クラウド上での開発')         AS "Azure→クラウド上での開発",
  skill_satisfies('BigQuery', 'クラウド上での開発')      AS "BigQuery→クラウド上での開発",
  skill_satisfies('Java', 'クラウド上での開発')          AS "Java→クラウド（falseが正しい）",
  skill_satisfies('ローコード開発', 'Power Apps')        AS "逆向き（falseが正しい）",
  (SELECT count(*) FROM skill_implications WHERE parent = 'クラウド開発')   AS "クラウドの包含本数",
  (SELECT count(*) FROM skill_implications WHERE parent = 'ローコード開発') AS "ローコードの包含本数",
  (SELECT array_to_string(selective_skills(ARRAY['C#','クラウド上での開発']), ' / '))
    AS "資格判定に使う必須スキル";
