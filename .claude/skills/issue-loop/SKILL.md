# Issue 自律修正ループ

GitHub の open Issue をすべて修正・クローズするまで自律的にループするスキル。

---

## 手順

### STEP 1 — Issue 一覧取得

```bash
node scripts/list_issues.mjs
```

- `open` な Issue が 0 件 → 「open な Issue はありません。完了です。」と報告して終了
- `open` な Issue がある → STEP 2 へ

### STEP 2 — 各 Issue を実装・修正

open Issue を優先度順（番号の小さい順）に 1 件ずつ処理する。

各 Issue に対して:
1. タイトルと URL から問題を把握する
2. 関連ファイルを Read して現状を確認する
3. 修正を実装する（Edit / Write）
4. `npx tsc --noEmit` でコンパイルエラーがないか確認する
5. Edge Function を変更した場合は `bash scripts/check-and-deploy-edge.sh inbound-email` を実行する
6. `git add -p` / `git commit` / `git push` でコミットする
7. STEP 3 へ

### STEP 3 — Issue をクローズ

```bash
node scripts/list_issues.mjs --close <番号>
```

クローズ成功を確認したら次の open Issue へ。

### STEP 4 — 再確認

```bash
node scripts/list_issues.mjs
```

- `open` な Issue がまだある → STEP 2 に戻って残りを処理する
- `open` な Issue が 0 件 → 完了を報告して終了

---

## 注意事項

- **ユーザーへの確認不要**: 修正内容が明確な場合は確認なしで実装してよい
- **破壊的変更は確認**: DB スキーマ変更・既存データ削除・外部 API の設定変更は実装前にユーザーに確認する
- **1 Issue = 1 commit**: Issue 番号をコミットメッセージに含める（例: `fix: #42 ...`）
- **Edge Function 変更時**: 必ず `bash scripts/check-and-deploy-edge.sh inbound-email` を使う（`deno check` で事前検証）
- **テスト**: regex 変更をする場合は `node scripts/test_extraction.mjs "..."` でローカル検証してからデプロイする
