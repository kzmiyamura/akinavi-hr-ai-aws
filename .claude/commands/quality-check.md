# 品質チェック

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
       SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
       ROUND(AVG(duration_ms)) AS avg_ms
FROM ai_logs
WHERE created_at > now() - interval '7 days'
GROUP BY model
ORDER BY total DESC;
```

- エラー率が10%超のモデルがあれば報告する
- 平均処理時間が異常に長いものがあれば報告する

---

## 完了報告

各ステップの結果を箇条書きで報告すること。問題なしの項目も「異常なし」と明記する。
