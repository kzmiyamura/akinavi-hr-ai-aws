---
name: quality-check
description: AkiNavi HR-AIの品質チェック。skill_masterメンテ・駅名マッピング・取りこぼし調査・異常監視・AIコスト監視・年齢性別取得率・フィールド充足率・名前汚染・非人材混入・分割失敗を順番に実施する。
---

以下の手順を順番に実施すること。各ステップで問題が見つかった場合は内容を報告し、修正が必要なものはユーザーに確認を取ってから実行する。

---

## ① skill_master メンテ

1. `python3 scripts/skill_master_review.py` を実行する
2. 削除候補として出力されたエントリのSQLをSupabase CLIで実行する
3. `match_count=0` かつ `last_matched_at` が30日以上前のエントリをSupabaseで確認し、不要なら削除SQLを実行する
4. 直近7日間に登録された人材・案件の `skills` カラムをスキャンし、`skill_master` に未登録のものを抽出する
   - ITスキルとして妥当なものをカテゴリ判定してINSERT SQLを生成 → ユーザー確認後に実行する

---

## ② 駅名マッピング

1. Supabase Dashboard → Functions → inbound-email → Logs で `[station_unmapped]` を検索する
2. 出現した駅名を集計し、頻出順に一覧表示する
3. 追加すべき駅名を `supabase/functions/inbound-email/index.ts` の `STATION_TO_PREFECTURE` に追記する → ユーザー確認後に `npm run deploy:edge` を実行する

---

## ③ 取りこぼし調査（確認を挟んで修正）

以下のSQLで直近14日間の登録データを抽出し、パターンを調査する。

**人材の取りこぼし:**
```sql
SELECT id, name, experience_years, raw_profile->>'nearestStation' AS station,
       raw_profile->>'prefecture' AS pref, created_at
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (name = '不明' OR experience_years IS NULL
       OR raw_profile->>'nearestStation' IS NULL
       OR raw_profile->>'prefecture' IS NULL)
ORDER BY created_at DESC
LIMIT 30;
```

- 名前が「不明」→ `raw_profile->>'text'` の本文を確認し、氏名regex の修正候補を提示
- 経験年数null → 本文の経験年数の書き方パターンを確認し、regex修正候補を提示
- 最寄駅/都道府県null → 本文の書き方を確認し、マッピング追加候補を提示
- ユーザー確認後に `inbound-email/index.ts` を修正 → `npm run deploy:edge`

**案件の取りこぼし:**
```sql
SELECT id, title, work_location, budget_min, budget_max, created_at
FROM projects
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (work_location IS NULL OR (budget_min IS NULL AND budget_max IS NULL))
ORDER BY created_at DESC
LIMIT 30;
```

- 勤務地null・単価null → `raw_data->>'text'` の本文パターンを確認し、修正候補を提示
- ユーザー確認後に修正 → `npm run deploy:edge`

**誤登録（案件が人材として登録されたもの）:**
```sql
SELECT id, name, skills, raw_profile->>'text' AS body_head, created_at
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (
    name = '不明'
    OR skills::text ILIKE '%案件%'
    OR raw_profile->>'text' ILIKE '%必須スキル%'
    OR raw_profile->>'text' ILIKE '%募集%'
  )
ORDER BY created_at DESC
LIMIT 20;
```

- 該当レコードの本文を確認し、誤判定の原因（送信アカウント・本文パターン）を調査
- 修正候補を提示 → ユーザー確認後に修正・デプロイ
- 誤登録レコードは手動削除を案内する

---

## ④ 異常監視

```sql
SELECT model, COUNT(*) AS total,
       SUM(CASE WHEN error_message IS NOT NULL THEN 1 ELSE 0 END) AS errors,
       ROUND(AVG(duration_ms)) AS avg_ms
FROM ai_logs
WHERE created_at > now() - interval '7 days'
GROUP BY model
ORDER BY total DESC;
```

- エラー率が10%超のモデルがあれば報告する
- 平均処理時間が異常に長いものがあれば報告する

---

## ⑤ AIコスト監視（費用削減）

### 5-1. モデル別・日次呼び出し数の集計

```sql
SELECT
  DATE(created_at AT TIME ZONE 'Asia/Tokyo') AS day,
  SUM(CASE WHEN model ILIKE '%gemini%'   THEN 1 ELSE 0 END) AS gemini,
  SUM(CASE WHEN model ILIKE '%gemini%' AND error_message IS NOT NULL THEN 1 ELSE 0 END) AS gemini_err,
  SUM(CASE WHEN model ILIKE '%groq%' OR model ILIKE '%llama%' THEN 1 ELSE 0 END) AS groq,
  SUM(CASE WHEN model ILIKE '%cerebras%' OR model = 'llama3.1-8b' THEN 1 ELSE 0 END) AS cerebras,
  SUM(CASE WHEN model ILIKE '%bedrock%'  THEN 1 ELSE 0 END) AS bedrock,
  SUM(CASE WHEN model = 'no-ai'          THEN 1 ELSE 0 END) AS no_ai
FROM ai_logs
WHERE created_at > now() - interval '14 days'
GROUP BY day
ORDER BY day DESC;
```

**チェックポイント:**
- **Gemini 無料枠**: gemini-2.5-flash-lite は 1,500 RPD / 15 RPM、gemini-2.5-flash は 500 RPD / 10 RPM
  - 1日の呼び出し数がこの値に近い/超えていれば「無料枠圧迫」として警告
- **Gemini エラー率が高い** → `[429 Too Many Requests]` は無料枠超過 or prepaymentクレジット枯渇のサイン
  - エラーメッセージ `"Your prepayment credits are depleted"` があれば即報告
- **Bedrock 列が 0 以外** → AWS Bedrock は有料サービス。不明な使用が発生していれば即報告し原因を調査
- **Groq**: 無料枠は llama-3.3-70b-versatile で約 1,000 RPD。超過は翌日リセット待ちか有料プランが必要
- **no-ai 列のみ** が理想状態（inbound-email の AI 廃止が正常に機能している）

### 5-2. フォールバック多発の検出

match-score は Cerebras → Groq → Gemini の順にフォールバックする。失敗が連鎖すると高コストな Gemini が多用される。

```sql
SELECT
  DATE(created_at AT TIME ZONE 'Asia/Tokyo') AS day,
  SUM(CASE WHEN model = 'llama3.1-8b' AND error_message IS NOT NULL THEN 1 ELSE 0 END) AS cerebras_fail,
  SUM(CASE WHEN (model ILIKE '%llama%' OR model ILIKE '%groq%') AND error_message IS NOT NULL THEN 1 ELSE 0 END) AS groq_fail,
  SUM(CASE WHEN model ILIKE '%gemini%' THEN 1 ELSE 0 END) AS gemini_total,
  SUM(CASE WHEN model ILIKE '%gemini%' AND error_message IS NOT NULL THEN 1 ELSE 0 END) AS gemini_fail
FROM ai_logs
WHERE created_at > now() - interval '7 days'
  AND type != 'no-ai'
GROUP BY day
ORDER BY day DESC;
```

- Gemini 呼び出しが Groq 呼び出しを大幅に上回る日があればフォールバック多発と判断
- 原因: Cerebras/Groq の無料枠枯渇、レート制限、API 障害

### 5-3. Gemini クレジット枯渇エラーの確認

```sql
SELECT error_message, COUNT(*) AS cnt,
       MIN(created_at)::date AS first_at, MAX(created_at)::date AS last_at
FROM ai_logs
WHERE model ILIKE '%gemini%'
  AND error_message IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY error_message
ORDER BY cnt DESC
LIMIT 5;
```

- `"prepayment credits are depleted"` が出ていれば AI Studio で残高確認を案内する
- `"429 Too Many Requests"` が続く場合は auto-match の実行頻度見直しを提案する

### 5-4. auto-match の処理量チェック

auto-match は毎日 JST 9:00 に動作し、直近 25 時間以内の案件に対して候補者を最大 40 名スコアリングする。

```sql
-- 直近14日の submissions 生成数（auto-match + 手動 match-score の合算）
SELECT
  DATE(created_at AT TIME ZONE 'Asia/Tokyo') AS day,
  COUNT(*) AS new_submissions,
  COUNT(DISTINCT candidate_id) AS unique_candidates,
  COUNT(DISTINCT project_id) AS unique_projects
FROM submissions
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
GROUP BY day
ORDER BY day DESC;
```

- 1日の submissions が急増している日は手動全件マッチングが実行された可能性がある
- 同じ candidate_id × project_id ペアが複数件ある場合は重複スコアリングを確認

```sql
-- 重複スコアリング検出
SELECT candidate_id, project_id, COUNT(*) AS score_count
FROM submissions
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
GROUP BY candidate_id, project_id
HAVING COUNT(*) > 1
ORDER BY score_count DESC
LIMIT 10;
```

### 5-5. コスト削減の推奨アクション（判断基準）

| 状態 | 推奨アクション |
|---|---|
| Gemini 1日 >1,000 回 | auto-match の対象案件・候補者数を削減を提案 |
| Gemini エラー率 >30% | prepayment クレジット残高確認・Groq への切替検討を提案 |
| Bedrock が登録されている | 即調査してコードから該当呼び出しを除去 |
| Groq フォールバック多発 | Cerebras の無料枠リセット待ち or Groq 有料プランを案内 |
| 重複スコアリング発見 | 対象ペアを削除し、`submissions` の UNIQUE 制約追加を検討 |

---

## ⑥ 年齢・性別取得率チェック

年齢はマッチングスコアに、性別は重複チェックに活用するため、取得率を定期確認する。

### 6-1. 取得率の集計（直近14日）

```sql
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN (raw_profile->>'age') IS NOT NULL THEN 1 ELSE 0 END) AS age_filled,
  SUM(CASE WHEN (raw_profile->>'gender') IS NOT NULL THEN 1 ELSE 0 END) AS gender_filled,
  ROUND(100.0 * SUM(CASE WHEN (raw_profile->>'age') IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS age_rate_pct,
  ROUND(100.0 * SUM(CASE WHEN (raw_profile->>'gender') IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS gender_rate_pct
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days';
```

- 取得率が **50% 未満** の場合は「低取得率」として次の調査に進む
- 取得率が **80% 以上** なら「正常」と報告して終了

### 6-2. 未取得サンプルの確認

```sql
SELECT
  id, name,
  raw_profile->>'age' AS age,
  raw_profile->>'gender' AS gender,
  LEFT(raw_profile->>'text', 300) AS body_head
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (raw_profile->>'age' IS NULL OR raw_profile->>'gender' IS NULL)
  AND name != '不明'
ORDER BY created_at DESC
LIMIT 10;
```

- `body_head` を目視確認し、年齢・性別が本文に記載されているのに取れていないパターンを抽出する
- 新たなパターンが見つかれば `inbound-email/index.ts` の `extractCandidateFieldsRegex` に正規表現を追加 → ユーザー確認後に `npm run deploy:edge`

### 6-3. よくある未取得パターン（参考）

| 本文の書き方 | 対応状況 |
|---|---|
| `（34歳/男性）` | ✅ 対応済み |
| `（34才：男性）` | ✅ 対応済み |
| `YS(26歳)` | ✅ 対応済み |
| `■C-TN（44歳 / 男性）` | ✅ 対応済み |
| `年齢: 34歳` `性別: 男性`（ラベルあり別行） | ❓ 要確認 |
| `34歳 男性`（括弧なし） | ❓ 要確認 |
| 1行形式の一括紹介メール | ❌ 取得不可（情報なし） |

---

## ⑦ フィールド充足率チェック（国籍・自己PR・agentComment）

新規フィールドが実際に取れているかを確認する。

```sql
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN raw_profile->>'nationality' IS NOT NULL THEN 1 ELSE 0 END) AS nationality_filled,
  SUM(CASE WHEN raw_profile->>'selfPR'      IS NOT NULL THEN 1 ELSE 0 END) AS selfpr_filled,
  SUM(CASE WHEN raw_profile->>'agentComment' IS NOT NULL THEN 1 ELSE 0 END) AS agent_filled,
  ROUND(100.0 * SUM(CASE WHEN raw_profile->>'nationality'  IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS nationality_pct,
  ROUND(100.0 * SUM(CASE WHEN raw_profile->>'selfPR'       IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS selfpr_pct,
  ROUND(100.0 * SUM(CASE WHEN raw_profile->>'agentComment' IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS agent_pct
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days';
```

- `nationality` は外国籍エンジニアが多い場合に取得率が上がる。0% に近くても異常ではないが、取れているべき候補者がいれば本文を確認する
- `selfPR` / `agentComment` は **20% 未満** なら取りこぼしが多いとして⑥-2 と同様にサンプル確認する

---

## ⑧ 名前汚染チェック（性別・年齢・記号が残っている）

名前フィールドに性別・年齢・記号が混入しているレコードを検出する。

```sql
SELECT id, name, created_at, LEFT(raw_profile->>'text', 200) AS body_head
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (
    name ~ '男性|女性|男$|女$'
    OR name ~ '\d+歳|\d+才'
    OR name ~ '[（(]\d+[）)]'
    OR name ~ '重複|不明|NULL'
  )
ORDER BY created_at DESC
LIMIT 20;
```

- 「K.T女性」「YS(26歳)」のように名前に性別・年齢が残っている場合は `inbound-email/index.ts` の名前抽出 regex を修正する
- 修正後、該当レコードは「再解析」ボタンで更新できることをユーザーに案内する

---

## ⑨ 非人材メール混入チェック

契約確認・連絡・報告等の業務メールが人材として登録されていないかを確認する。

```sql
SELECT id, name, created_at,
       raw_profile->>'subject' AS subject,
       raw_profile->>'from'    AS from_email,
       LEFT(raw_profile->>'text', 150) AS body_head
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (
    raw_profile->>'subject' ~* '契約|確認|ご連絡|報告|請求|お知らせ|案内|返信|RE:|Fwd:'
    OR (name = '不明' AND raw_profile->>'text' ~* '契約|請求|報告')
  )
ORDER BY created_at DESC
LIMIT 20;
```

- 該当レコードの本文を確認し、人材情報でないと判断した場合は削除を案内する
- 件名パターンが再発しそうであれば `inbound-email/index.ts` の `PROJECT_SOLICITATION_KEYWORDS` に追加する
- 例: `'契約確認'`, `'契約のご連絡'`, `'今回の注力エンジニア'`（一括紹介メール）

---

## ⑩ 複数人メール分割失敗チェック

1通のメールに複数人が含まれているのに1件しか登録されていないケースを検出する。

```sql
-- 同一送信元・同日に1件しか登録されていないのに本文が長いレコードを抽出
SELECT
  raw_profile->>'from'    AS from_email,
  DATE(created_at AT TIME ZONE 'Asia/Tokyo') AS day,
  COUNT(*)                AS registered_count,
  MAX(LENGTH(raw_profile->>'text')) AS max_body_len
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
GROUP BY from_email, day
HAVING COUNT(*) = 1
   AND MAX(LENGTH(raw_profile->>'text')) > 2000
ORDER BY max_body_len DESC
LIMIT 20;
```

- `max_body_len > 2000` かつ登録数 = 1 の場合、複数人分の情報が1レコードに混入している疑いがある
- 該当レコードの `raw_profile->>'text'` を確認し、区切り線のパターンを調査する
- `splitMultiCandidateBody` の `DELIM_RE` や `CANDIDATE_FIELD_RE` を調整して対応する

---

## ⑪ スキル別経験年数（skillYears）取得率チェック

`skillYears` は Excel スキルシート添付がある場合のみ取得できる。取得率が低い場合はシート形式が未対応の可能性がある。

### 11-1. 取得率の集計（直近14日）

```sql
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN raw_profile ? 'skillYears'
            AND raw_profile->'skillYears' != '{}'::jsonb THEN 1 ELSE 0 END) AS skill_years_filled,
  ROUND(100.0 * SUM(CASE WHEN raw_profile ? 'skillYears'
            AND raw_profile->'skillYears' != '{}'::jsonb THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS skill_years_pct,
  -- drive_url/resume_url あり（Excel添付の可能性が高い）の内訳
  SUM(CASE WHEN drive_url IS NOT NULL OR resume_url IS NOT NULL THEN 1 ELSE 0 END) AS has_drive_link,
  SUM(CASE WHEN (drive_url IS NOT NULL OR resume_url IS NOT NULL)
            AND raw_profile ? 'skillYears'
            AND raw_profile->'skillYears' != '{}'::jsonb THEN 1 ELSE 0 END) AS drive_with_skill_years
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days';
```

- `skill_years_pct` が **10% 未満** であれば「低取得率」として 11-2 へ進む
- `has_drive_link` が多いのに `drive_with_skill_years` が少ない場合 → Excel フォーマット未対応の可能性大

### 11-2. Edge Function ログで直接確認

Supabase Dashboard → Functions → inbound-email → Logs で以下のキーワードを検索する。

| キーワード | 意味 |
|---|---|
| `[Excel-raw]` | シートの生データ（先頭50行・2000文字チャンク）。何が来ているか確認できる |
| `[skillYears]` | 取得成功。`keys=` にスキル名リストが出る |
| `[skillYears-miss]` | 取得失敗。`head=` に先頭3行×8列が出るのでフォーマットを診断できる |

**`[skillYears-miss]` の診断手順:**
1. `head=` の内容を見て列構成を確認する
2. 「使用言語」「FW」「ツール」列ヘッダーがあるか → Method 1 の対象
3. スキル名と年数が同行にあるか → Method 2 の対象
4. どちらにも当てはまらない新フォーマットなら `extractSkillYearsFromSheetData` に新ケースを追加

### 11-3. 未取得サンプルの確認（スキル10件以上なのに skillYears なし）

スキルが多く抽出されているのに skillYears がない候補者は Excel 添付がある可能性が高い。

```sql
SELECT
  id, name,
  jsonb_array_length(skills) AS skill_count,
  drive_url IS NOT NULL AS has_drive,
  resume_url IS NOT NULL AS has_resume,
  LEFT(raw_profile->>'text', 500) AS body_head
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (NOT (raw_profile ? 'skillYears') OR raw_profile->'skillYears' = '{}'::jsonb)
  AND jsonb_array_length(skills) >= 10
ORDER BY skill_count DESC, created_at DESC
LIMIT 10;
```

- `body_head` を確認し、Excel 添付があったかどうか・経験年数の書き方を調査する
- 未対応フォーマットのパターンを特定したら `extractSkillYearsFromSheetData` の修正候補を提示
- ユーザー確認後に `inbound-email/index.ts` を修正 → `bash scripts/check-and-deploy-edge.sh inbound-email`

### 11-3. 取得できているサンプルの確認（正常ケースの把握）

```sql
SELECT
  id, name,
  jsonb_array_length(skills) AS skill_count,
  raw_profile->'skillYears' AS skill_years
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND raw_profile ? 'skillYears'
  AND raw_profile->'skillYears' != '{}'::jsonb
ORDER BY created_at DESC
LIMIT 5;
```

- `skill_years` の中身を確認し、スキル名と年数が正しく対応しているか確認する
- `_totalProjectMonths` キーが含まれている場合は Method 1（案件一覧形式）で取得済み

### 11-4. skillYears の仕組み（参考）

| Method | シート形式 | 取得条件 |
|---|---|---|
| Method 1 | 案件一覧（期間列あり） | 「期間」「PJ期間」等の列 + 「年」「ヶ月」形式の値がある |
| Method 2 | スキルリスト（経験年数列あり） | スキル名 + 隣接セルに「N年Mヶ月」または数値がある |

- `parseDurationToMonths` が `> 50年` をガード → 西暦年（2020年等）の誤マッチは除外済み
- `SKILL_LABEL_BLOCKLIST` で「自己PR」「氏名」等のセクションヘッダーは除外済み
- 未対応の主なパターン: 「経験年数」列の値が「3」等の数値のみ（単位なし）

---

## ⑫ 抽出ロジック回帰テスト

品質チェックの最後に必ず実行する。

```bash
node scripts/test_extraction.mjs --test
```

- **45 passed, 0 failed** なら「異常なし」と報告して終了
- **失敗があった場合**:
  1. 失敗したテストケースの内容を報告する
  2. `supabase/functions/inbound-email/index.ts` の該当 regex を修正する
  3. `scripts/test_extraction.mjs` にも同じ修正を反映する（両ファイルの同期を保つこと）
  4. 再度 `node scripts/test_extraction.mjs --test` を実行して全件パスを確認
  5. `bash scripts/check-and-deploy-edge.sh inbound-email` でデプロイする
  6. commit & push する

---

## 完了報告

各ステップの結果を箇条書きで報告すること。問題なしの項目も「異常なし」と明記する。
