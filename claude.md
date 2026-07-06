# プロジェクト概要: AkiNavi HR-AI（アキナビ HR-AI）

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。

## 2. 技術スタック
- **Frontend**: React 19 (Vite 8), TypeScript, Tailwind CSS v4, TanStack Query v5
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, pg_cron, pg_net)
- **ファイルパース（ブラウザ）**: `xlsx`（Excel）・`mammoth`（Word）— `src/lib/fileParser.ts`。PDF・画像は未対応
- **AI（ブラウザ）**: Gemini `gemini-2.5-flash-lite`（`VITE_GEMINI_MODEL` で上書き可）。人材・案件登録 UI からは呼ばない
- **AI（サーバー・マッチング）**: Cerebras `llama3.1-8b` → Groq `llama-3.3-70b-versatile` → Gemini `gemini-2.5-flash`（3段フォールバック）。`match-batch` / `match-score` / `auto-match` が使用
- **AI（サーバー・メール解析）**: AI 不使用。regex + `skill_master` DB照合のみ（`inbound-email` Edge Function）
- **メール自動取り込み**: Microsoft Graph API ポーリング + pg_cron（5分間隔）
- **Testing**: Vitest, React Testing Library, MSW
- **Deployment**: Vercel (Frontend), Supabase (Backend)

---

## 3. Claude Code 操作権限ポリシー

### 確認なしで即実行してよい操作

| カテゴリ | 具体例 |
|---|---|
| ファイル読み書き | Read / Edit / Write |
| TypeScript ビルド確認 | `npx tsc --noEmit` |
| テスト実行 | `npm test` / `npx vitest run` |
| 依存パッケージ追加 | `npm install <package>` |
| Edge Function デプロイ | `bash scripts/check-and-deploy-edge.sh <function>` |
| Git 操作（通常） | `git add` / `git commit` / `git push` |
| GitHub Issue 操作 | Issue 作成・クローズ |
| Supabase SQL 実行 | `supabase db query --linked -f <file>` |

### 必ず確認してから実行する操作

| カテゴリ | 具体例 |
|---|---|
| 強制 push | `git push --force` |
| ブランチ削除 | `git branch -D` |
| 大量削除 | `rm -rf` / DB テーブル DROP / `DELETE` 条件なし |
| 本番データ変更 | Supabase prod テーブルへの直接 UPDATE / INSERT |
| 環境変数・Secrets 変更 | Supabase Secrets の追加・変更・削除 |
| 外部サービス設定変更 | Azure / GitHub / Vercel の設定変更 |
| 課金が発生する操作 | 有料 API の大量呼び出し・プラン変更 |

---

## 4. 行動指針

- **正の所在**: 仕様はソースコードが正。CLAUDE.md と食い違いがあればソースに合わせて本ファイルを更新する
- **こまめな Git 操作**: 機能実装単位・テスト通過ごとに commit & push
- **バグゼロの追求**: ロジックには必ずテストコードを付随させる
- **Issue 作業サイクル（自律ループ）**:
  1. `node scripts/list_issues.mjs` で open Issue を確認
  2. 実装・修正・テスト → commit & push
  3. `node scripts/list_issues.mjs --close <番号>` でクローズ
  4. open Issue が 0 件になるまで繰り返す（ユーザーへの確認不要）
- **Excel/Word解析 精度改善サイクル（自律ループ）**: 手順は下記「Excel/Word解析 精度改善ループ」参照。以下をユーザー確認なしで繰り返す
  1. `node scripts/test_excel_parsing.mjs --compact --new` で WARN・FAIL・誤抽出（案件名をスキルと誤認識 等）を洗い出す
  2. 仮説立案 → `supabase/functions/inbound-email/index.ts` の抽出関数を修正
  3. `node scripts/sync_extractors.mjs` で再生成
  4. 再テストし、既存回帰（`testData/excel/*.xlsx` 14件・`testData/failures/*.txt` 3件）が **0件劣化** であることを確認してから次へ進む（劣化していたら修正をやり直す）
  5. `--log` で改善内容を記録 → `check-and-deploy-edge.sh inbound-email` でデプロイ → commit & push
  6. 新規 WARN/FAIL/誤抽出が無くなるまで 1〜5 を繰り返す

### よく使うスクリプト
- `node scripts/list_issues.mjs [--close N]` — GitHub Issue 一覧取得・クローズ
- `node scripts/test_extraction.mjs "本文"` — regex 抽出をデプロイなしでローカル検証（変更前後に必ず使う）
- `node scripts/check_extraction.mjs` — 直近14日の取りこぼし調査
- `bash scripts/check-and-deploy-edge.sh <function>` — deno check + deploy（Edge Function は必ずこれを使う）
- `node scripts/test_excel_parsing.mjs --compact` — Excel/Word解析品質メトリクス（Claude読み取り用）
- `node scripts/test_excel_parsing.mjs --compact --new` — 未分類 xlsx も含めて検証
- `node scripts/test_excel_parsing.mjs` — 詳細デバッグ出力（人力調査用）
- `node scripts/sync_extractors.mjs` — index.ts の純粋関数を `_extractors.gen.mjs` に再生成（index.ts を変更したら必ず実行）

### Excel/Word解析 精度改善ループ

```
# 1. 品質チェック（コンパクト出力）
node scripts/test_excel_parsing.mjs --compact

# 2. 失敗ファイルを調査（詳細出力で仮説立案）
node scripts/test_excel_parsing.mjs     # 詳細で [DBG] を確認

# 3. index.ts の抽出関数を修正（正：supabase/functions/inbound-email/index.ts）

# 4. _extractors.gen.mjs を再生成
node scripts/sync_extractors.mjs

# 5. 改善確認
node scripts/test_excel_parsing.mjs --compact

# 6. 記録・デプロイ・コミット
node scripts/test_excel_parsing.mjs --log "変更内容メモ"
bash scripts/check-and-deploy-edge.sh inbound-email
git add -A && git commit -m "fix: ..." && git push
```

**注意**:
- 修正対象は常に `supabase/functions/inbound-email/index.ts`。`_extractors.gen.mjs` は自動生成なので直接編集しない
- `testData/excel/*.xlsx`（14件）がリグレッションテスト用。`testData/failures/*.txt`（3件）がテキスト抽出テスト用
- 新しい問題 Excel は `testData/excel/` に追加して再テスト
- 改善履歴は `scripts/testData/improvement_log.md` を参照

### スキル
- `/issue-loop` — Issue 自律修正ループ
- `/deploy-edge` — Edge Function デプロイ
- `/quality-check` — skill_master メンテ・駅名マッピング・取りこぼし調査・異常監視

---

## 5. データベース構成

`candidate_skills` のカテゴリ CHECK 制約は `supabase/migrations/add_candidate_skills.sql` を正とする。

### テーブル一覧
| テーブル | 用途 |
|---|---|
| `candidates` | 人材マスタ。`data_env`（`prod`/`demo`）で論理分離。主要カラム: `box_url`, `resume_url`, `drive_url`, `desired_rate`, `from_company`, `duplicate_flag`, `merged_into` |
| `projects` | 案件マスタ。`data_env` 同上 |
| `submissions` | マッチング提案履歴 |
| `candidate_skills` | スキルをカテゴリ別に分解（14カテゴリ） |
| `candidates_archive_light` | 人材マップ用サマリー。7日経過 prod 人材を `archive-candidates` Edge Function が毎日 JST 0:00 に移動 |
| `ai_logs` | AI呼び出しログ。`inbound-email` 由来は `model='no-ai'` |
| `error_logs` | フロントエンドエラーログ。30日自動削除 cron は未実装（要追加） |
| `skill_master` | ITスキルマスタ（約1,660件）。aliases で表記ゆれ吸収 |
| `station_master` | 駅名→都道府県マッピング（全国1,797駅）。`inbound-email` 起動時にキャッシュ |
| `app_config` | アプリ全体設定・Microsoft OAuthトークン保存 |

### app_config の主要キー
| キー | 既定 | 内容 |
|---|---|---|
| `inbound_project_enabled` | `false` | 案件メールの解析・DB保存を有効化 |
| `auto_match_enabled` | `true` | `auto-match` cron を有効化 |
| `email_poll_mode` | `incremental` | `incremental`（未読のみ）/ `full`（指定日以降全件） |
| `email_classify_enabled` | `false` | poll-email 内の Gemini メール種別分類 |
| `matching_run_mode` | `fast` | `fast` / `full`。SettingsPage から変更可 |
| `matching_fast_max_candidates` | `20` | 高速モード時の案件あたり候補者上限 |
| `matching_fast_max_projects` | `10` | 高速モード時の人材あたり案件上限 |
| `candidate_retention_days` | `7` | 人材データ保持日数 |
| `app_memo` | — | 営業引き継ぎ用フリーテキスト |

---

## 6. アーキテクチャメモ

- **マッチングスコア計算**: `fetch_candidates_for_project` RPC（SQL）でルールスコアを計算 → topN件だけ AI 採点。スコア配点・ウェイト詳細はRPC定義を参照
- **inbound-email 処理フロー**: `supabase/functions/inbound-email/index.ts` を参照
- **論理データ環境**: `prod` / `demo` を `data_env` カラムで分離。SettingsPage の「デモモード」スイッチで切替
- **画面構成**: ナビは4タブ（マッチング/人材/案件/設定）。`src/components/Layout.tsx` の `NAV_ITEMS` を正とする
- **認証なし**: ニックネームを `localStorage` に保存
- **重複管理**: email一致で自動UPDATE。名前一致 + スキルJaccard ≥ 0.4 で `duplicate_flag=true`
