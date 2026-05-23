---
name: quality-check
description: AkiNavi HR-AIの品質チェック。skill_masterメンテ・駅名マッピング・取りこぼし調査・異常監視・AIコスト監視を順番に実施する。
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

## 完了報告

各ステップの結果を箇条書きで報告すること。問題なしの項目も「異常なし」と明記する。
