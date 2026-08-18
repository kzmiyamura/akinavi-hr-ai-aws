---
name: quality-check
description: AkiNavi HR-AIの品質チェック。skill_masterメンテ・駅名マッピング・取りこぼし調査・異常監視・AIコスト監視・年齢性別取得率・フィールド充足率・名前汚染・非人材混入・分割失敗・skillYears取得率・回帰テストを順番に実施し、問題があれば自動修正する。
---

## 基本方針

**問題を発見したら確認なしで即修正する。** ただし以下は例外とする。

| 操作 | 方針 |
|---|---|
| skill_master INSERT / DELETE | 自動実行 |
| station_master INSERT | 自動実行 |
| inbound-email regex 修正 + deploy | 自動修正 → `deno check` → deploy → 回帰テストで検証 |
| PROJECT_SOLICITATION_KEYWORDS 追加 | 自動修正 → deploy |
| **候補者レコード削除（誤登録）** | **削除はしない。対象IDと理由を報告してユーザーに委ねる** |
| AI コスト・異常監視 | 報告のみ（修正先がコード外のため） |

各ステップ完了後に「対処した内容」を箇条書きで報告すること。問題がなかった項目も「異常なし」と明記する。

---

## ① skill_master メンテ

1. `python3 scripts/skill_master_review.py` を実行する
2. 削除候補として出力されたエントリの DELETE SQL を **即実行する**
3. `match_count=0` かつ `last_matched_at` が30日以上前のエントリを取得し、**即削除する**

```sql
DELETE FROM skill_master
WHERE match_count = 0
  AND (last_matched_at IS NULL OR last_matched_at < now() - interval '30 days')
  AND source = 'ai';
```

4. 直近7日間に登録された人材・案件の `skills` カラムをスキャンし、`skill_master` に未登録のものを抽出する
   - ITスキルとして妥当なものをカテゴリ判定して INSERT SQL を生成し **即実行する**
   - 判断基準: プログラミング言語・FW・DB・クラウド・ツール・資格に明確に分類できるもののみ。「普通名詞」「動詞」「業種名」は追加しない

---

## ② 駅名マッピング

1. 以下の MCP ツールで直近の `[station_unmapped]` ログを取得する（`mcp__supabase__get_logs` function=`inbound-email` keyword=`station_unmapped`）
2. 出現した駅名を頻出順に集計する
3. 追加すべき駅名を `station_master` テーブルに **即 INSERT する**

```sql
INSERT INTO station_master (name, prefecture)
VALUES ('駅名', '都道府県名')
ON CONFLICT (name) DO NOTHING;
```

※ `STATION_TO_PREFECTURE` コードの修正は不要（Phase 4.14 で DB 化済み）

---

## ③ 取りこぼし調査（自動修正）

以下の SQL で直近14日間の登録データを抽出してパターンを調査する。

**人材の取りこぼし:**
```sql
SELECT id, name, experience_years, raw_profile->>'nearestStation' AS station,
       raw_profile->>'prefecture' AS pref,
       LEFT(raw_profile->>'text', 400) AS body_head,
       created_at
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (name = '不明' OR experience_years IS NULL
       OR raw_profile->>'nearestStation' IS NULL
       OR raw_profile->>'prefecture' IS NULL)
ORDER BY created_at DESC
LIMIT 30;
```

- 名前が「不明」→ `body_head` を読んで氏名 regex の修正を **inbound-email/index.ts に直接適用する**
- 経験年数 null → 本文の書き方パターンを確認し、regex を **直接追加する**
- 最寄駅/都道府県 null → station_master に INSERT する（→ ② に戻る）
- 修正したら `bash scripts/check-and-deploy-edge.sh inbound-email` を実行する

**案件の取りこぼし:**
```sql
SELECT id, title, work_location, budget_min, budget_max,
       LEFT(raw_data->>'text', 400) AS body_head, created_at
FROM projects
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (work_location IS NULL OR (budget_min IS NULL AND budget_max IS NULL))
ORDER BY created_at DESC
LIMIT 30;
```

- 勤務地 null・単価 null → `body_head` を確認して regex を **直接修正 → deploy**

**誤登録（案件が人材として登録されたもの）:**
```sql
SELECT id, name, raw_profile->>'subject' AS subject,
       LEFT(raw_profile->>'text', 150) AS body_head, created_at
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

- 誤登録と判断したら **ID・件名・理由を報告する（削除はしない）**
- 再発防止のキーワードがあれば `PROJECT_SOLICITATION_KEYWORDS` に **直接追加 → deploy**

---

## ④ 異常監視（報告のみ）

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
- **この項目は報告のみ。コード修正は行わない**

---

## ⑤ AIコスト監視（報告のみ）

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
- Gemini 1日 >1,000 回 → 警告
- Gemini エラー率 >30% → prepayment クレジット残高確認を案内
- `"prepayment credits are depleted"` → 即報告
- Bedrock 列が 0 以外 → 即報告・原因調査
- no-ai 列のみが理想状態

### 5-2. フォールバック多発の検出

```sql
SELECT
  DATE(created_at AT TIME ZONE 'Asia/Tokyo') AS day,
  SUM(CASE WHEN model = 'llama3.1-8b' AND error_message IS NOT NULL THEN 1 ELSE 0 END) AS cerebras_fail,
  SUM(CASE WHEN (model ILIKE '%llama%' OR model ILIKE '%groq%') AND error_message IS NOT NULL THEN 1 ELSE 0 END) AS groq_fail,
  SUM(CASE WHEN model ILIKE '%gemini%' THEN 1 ELSE 0 END) AS gemini_total
FROM ai_logs
WHERE created_at > now() - interval '7 days'
  AND type != 'no-ai'
GROUP BY day
ORDER BY day DESC;
```

### 5-3. 重複スコアリング検出

```sql
SELECT candidate_id, project_id, COUNT(*) AS score_count
FROM submissions
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
GROUP BY candidate_id, project_id
HAVING COUNT(*) > 1
ORDER BY score_count DESC
LIMIT 10;
```

---

## ⑥ 年齢・性別取得率チェック（低率なら自動修正）

```sql
SELECT
  COUNT(*) AS total,
  ROUND(100.0 * SUM(CASE WHEN (raw_profile->>'age') IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS age_rate_pct,
  ROUND(100.0 * SUM(CASE WHEN (raw_profile->>'gender') IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS gender_rate_pct
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days';
```

- 50% 以上 → 正常、次へ
- 50% 未満 → 未取得サンプルを取得して `body_head` を確認し、新パターンの regex を `inbound-email/index.ts` に **直接追加 → deploy**

```sql
SELECT id, name, LEFT(raw_profile->>'text', 300) AS body_head
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (raw_profile->>'age' IS NULL OR raw_profile->>'gender' IS NULL)
  AND name != '不明'
ORDER BY created_at DESC
LIMIT 10;
```

---

## ⑦ フィールド充足率チェック（低率なら自動修正）

```sql
SELECT
  COUNT(*) AS total,
  ROUND(100.0 * SUM(CASE WHEN raw_profile->>'nationality' IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS nationality_pct,
  ROUND(100.0 * SUM(CASE WHEN raw_profile->>'selfPR'      IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS selfpr_pct,
  ROUND(100.0 * SUM(CASE WHEN raw_profile->>'agentComment' IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS agent_pct
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days';
```

- `selfPR` / `agentComment` が 20% 未満 → サンプル確認して regex を **直接追加 → deploy**
- `nationality` は外国籍エンジニアが少なければ 0% でも正常

---

## ⑧ 名前汚染チェック（自動修正）

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

- 汚染パターンを確認し、名前抽出 regex のクリーニングロジックを **直接修正 → deploy**
- 修正後「再解析ボタンで更新できます」とユーザーに案内する

---

## ⑨ 非人材メール混入チェック

```sql
SELECT id, name, raw_profile->>'subject' AS subject,
       raw_profile->>'from' AS from_email,
       LEFT(raw_profile->>'text', 150) AS body_head, created_at
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

- 人材情報でないと判断したら **ID・件名・理由を報告する（削除はしない）**
- 再発防止キーワードがあれば `PROJECT_SOLICITATION_KEYWORDS` に **直接追加 → deploy**

### 9-2. ワーカーが隔離した人材の棚卸し（2026-08-19 追加・必須）

ワーカーは「非人材」と判定した人材を一覧から隔離する（`merged_into` を自己参照）。
**以前は隔離のたびに GitHub Issue を作っていたが、誰も対応しないまま溜まり、
しかも中身は誤検知が大半だった（14件中10件）。Issue 作成は廃止し、ここで確認する。**

```
node scripts/audit_quarantined.mjs        # 直近7日の隔離を元メール単位で表示
```

見るポイント:

| 隔離されていて良いもの | 隔離してはいけないもの（＝誤検知） |
|---|---|
| 営業の定期配信・案内メール | 件名に「直人材」「弊社社員」「弊社FL」「人材一覧」等がある |
| 案件紹介メール | 氏名（イニシャル含む）が取れている |

- 誤検知を見つけたら **`node scripts/restore_candidate.mjs <id>` で復活させる**
- 誤検知が続くなら判定を直す（`shadow_worker.mjs` の非人材検知 →
  条件は `scripts/llm_extract/quarantine_selftest.mjs` で固定してある）
- **AI（Haiku）の mailType 判定は外すことがある**。regex が氏名を取れているなら
  そちらを信じる、が現在の方針

---

## ⑩ 複数人メール分割失敗チェック（自動修正）

```sql
SELECT
  raw_profile->>'from' AS from_email,
  DATE(created_at AT TIME ZONE 'Asia/Tokyo') AS day,
  COUNT(*) AS registered_count,
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

- 該当レコードの本文を確認し、区切り線パターンを調査する
- 新パターンがあれば `splitMultiCandidateBody` の `DELIM_RE` を **直接修正 → deploy**

---

## ⑪ skillYears 取得率チェック（自動修正）

### 11-1. 取得率の集計

```sql
SELECT
  COUNT(*) AS total,
  ROUND(100.0 * SUM(CASE WHEN raw_profile ? 'skillYears'
            AND raw_profile->'skillYears' != '{}'::jsonb THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS skill_years_pct,
  SUM(CASE WHEN drive_url IS NOT NULL OR resume_url IS NOT NULL THEN 1 ELSE 0 END) AS has_drive_link,
  SUM(CASE WHEN (drive_url IS NOT NULL OR resume_url IS NOT NULL)
            AND raw_profile ? 'skillYears'
            AND raw_profile->'skillYears' != '{}'::jsonb THEN 1 ELSE 0 END) AS drive_with_skill_years
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days';
```

- `skill_years_pct` が 10% 未満 → 11-2 へ
- `has_drive_link` が多いのに `drive_with_skill_years` が少ない → フォーマット未対応の疑い、11-2 へ

### 11-2. `skillYears-miss` ログ解析

MCP ツール `mcp__supabase__get_logs` で function=`inbound-email` keyword=`skillYears-miss` を取得する。

`head=` の内容から未対応フォーマットを特定し、`extractSkillYearsFromSheetData` または `extractSkillYearsFromCells` に新ケースを **直接追加 → `bash scripts/check-and-deploy-edge.sh inbound-email`**

### 11-3. スキル数が多いのに skillYears なしの候補者を確認

```sql
SELECT id, name,
  jsonb_array_length(skills) AS skill_count,
  drive_url IS NOT NULL AS has_drive,
  LEFT(raw_profile->>'text', 500) AS body_head
FROM candidates
WHERE data_env = 'prod'
  AND created_at > now() - interval '14 days'
  AND (NOT (raw_profile ? 'skillYears') OR raw_profile->'skillYears' = '{}'::jsonb)
  AND jsonb_array_length(skills) >= 10
ORDER BY skill_count DESC, created_at DESC
LIMIT 10;
```

---

## ⑫ 抽出ロジック回帰テスト（必須・最後に実行）

```bash
node scripts/test_extraction.mjs --test
```

- 全件 passed → 完了
- 失敗があった場合:
  1. 失敗テストの内容を確認する
  2. `inbound-email/index.ts` の該当 regex を **直接修正する**
  3. `scripts/test_extraction.mjs` にも同じ修正を反映する（両ファイル同期必須）
  4. 再度テストを実行して全件パスを確認する
  5. `bash scripts/check-and-deploy-edge.sh inbound-email` でデプロイする
  6. commit & push する

---

## 完了報告

以下の形式で報告すること:

```
## 品質チェック完了レポート

① skill_master: 削除X件 / 追加Y件
② 駅名マッピング: 追加Z駅
③ 取りこぼし調査: [修正内容 or 異常なし]
④ 異常監視: [状況]
⑤ AIコスト: [状況]
⑥ 年齢・性別取得率: age=X% / gender=Y% [修正内容 or 異常なし]
⑦ フィールド充足率: nationality=X% / selfPR=Y% / agentComment=Z% [修正内容 or 異常なし]
⑧ 名前汚染: [修正内容 or 異常なし]
⑨ 非人材混入: 要削除ID=[...] or 異常なし
⑩ 複数人分割: [修正内容 or 異常なし]
⑪ skillYears取得率: X% [修正内容 or 異常なし]
⑫ 回帰テスト: passed X件 / failed 0件
```
