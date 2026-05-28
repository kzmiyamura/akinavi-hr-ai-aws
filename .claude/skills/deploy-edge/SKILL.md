# Edge Function デプロイ

Edge Function の検査・デプロイ・Git コミット・Push を一括実行するスキル。

---

## 手順

### STEP 1 — 対象 Function の確認

引数で Function 名が指定されている場合はそれを使う。
指定がない場合は **`inbound-email`** をデフォルトとする。

よくある対象:
- `inbound-email` — メール解析・人材・案件登録
- `match-batch` — バッチマッチングスコア計算
- `match-score` — 単発スコア計算
- `auto-match` — 自動マッチング cron
- `poll-email` — Microsoft Graph API メール取得
- `create-github-issue` — GitHub Issue 操作

### STEP 2 — deno check + デプロイ

```bash
bash scripts/check-and-deploy-edge.sh <function名>
```

- `deno check` でコンパイルエラーがあればデプロイ中止し、エラー内容を報告する
- エラーなしの場合は `supabase functions deploy <function名>` を実行する

### STEP 3 — Git コミット & Push

デプロイ成功後:

```bash
git add supabase/functions/<function名>/
git commit -m "deploy: <function名> を更新"
git push
```

コミットメッセージには変更内容の要約を含める（例: `deploy: inbound-email 国籍抽出の全角スペース対応`）。

---

## 注意事項

- `check-and-deploy-edge.sh` は `deno check` で **TS2304（未定義変数）** を検知したらデプロイを止める
- 型互換エラー（TS2345 等）は無視されるが、未定義変数は必ず修正してからデプロイすること
- Edge Function を複数同時にデプロイする場合は 1 つずつ順番に実行する
- regex 変更をした場合は先に `node scripts/test_extraction.mjs "..."` でローカル検証してからデプロイすること
