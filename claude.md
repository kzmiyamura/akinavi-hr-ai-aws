# プロジェクト概要: AkiNavi HR-AI（アキナビ HR-AI）

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。
バグゼロを目指した徹底的なテスト、こまめなGit管理、および将来の担当者が即座に再現可能なドキュメント完備をゴールとする。

## 2. 技術スタック
- **Frontend**: React 19 (Vite 8), TypeScript, Tailwind CSS v4, TanStack Query v5
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, Realtime, pg_cron, pg_net)
- **AI（ブラウザ）**: Google Gemini デフォルト `gemini-2.5-flash-lite`（`VITE_GEMINI_MODEL` で上書き可）。**人材・案件登録の UI からは Gemini を使わなくなった**（コミット `f28ec86` で「AI で登録」ボタン廃止）。`src/lib/ai/geminiProvider.ts` は残るが UI 接続なし
- **ファイルパース（ブラウザ）**: `xlsx`（Excel）・`mammoth`（Word）— `src/lib/fileParser.ts`。**PDF と画像は現状未対応**（旧 `pdfjs-dist` は依存に残るが import なし。CandidatePage / ProjectPage で「PDF は手動貼り付けか画像化して添付」を案内）
- **AI（サーバー・メール解析）**: **AI 不使用**。`inbound-email` Edge Function は regex（`extractCandidateFieldsRegex`） + 文章スキャン（`extractFromProse`） + `skill_master` DB 照合 + 駅→都道府県マッピング のみで構造化抽出する（コミット `139a4f2` で AI 廃止、`a4dc3b4` で `classifyInboundRelevance` / `generateJSONSmart` 等のデッドコードも完全削除済み）。残存 AI 呼び出しは自動マッチング用 `matchCandidateToProject`（`AUTO_MATCH_ENABLED='true'` 時の即時マッチ）のみ
- **AI（サーバー・マッチング・新方式 `match-batch`）**: コミット `b35df40` で導入、Phase 4.13 で SQL 化・ウェイト可変・地方加点を追加。**ルールベース事前フィルタを SQL 側に全移動（`fetch_candidates_for_project` RPC）→ topN（既定 10 件）だけバッチ AI 採点**。ウェイトは引数で可変（既定: スキル40 / 経験15 / 単価15 / 勤務地20 / リモート10 = 100pt）。AI フォールバック順は Cerebras `llama3.1-8b` → Groq `llama-3.3-70b-versatile` → Gemini `gemini-2.5-flash`。Cerebras はプロンプト 22500 文字超でスキップ。AI が 3 段とも失敗したらルールスコアで全代替。AI スコアは **ruleScore ±15pt** 以内に丸める（ハルシネーション抑制）。スキル全不一致時の合計は 35pt 上限。歓迎スキル一致は +0.1 ボーナス（最大 40pt キャップ）
- **AI（サーバー・マッチング・既存 `match-score`）**: UI 手動の単発スコア計算（`duplicateSuspected` フラグ込み）。フォールバック順は同上。マッチング理由は **120〜150 字以内**で「ルールスコア breakdown → 必須スキル → 経験 → 単価 → 勤務地 → リモート → 人物像 / 本人希望 / 国籍懸念」の優先順。スコア数値・分数表記・余計な推測は禁止
- **AI（サーバー・マッチング・自動 cron `auto-match`）**: 毎朝 JST 9:00 起動。**`match-batch` を経由**して Cerebras/Groq/Gemini フォールバック付き。`MAX_CANDIDATES_PER_PROJECT=40` / `BATCH_AI_SIZE=20`、`app_config.auto_match_enabled='false'` でスキップ
- **AI（サーバー・メール種別分類）**: `poll-email` 内で Gemini バッチ分類（任意・既定 `app_config.email_classify_enabled='false'`）
- **AI（切替・フロントのみ）**: `VITE_AI_PROVIDER=gemini` / `openai` — OpenAI は未実装スタブ
- **メール自動取り込み（現行・稼働中）**: Microsoft Graph API ポーリング + Supabase pg_cron（Make.com不要・完全無料・5分間隔）
- **メール自動取り込み（旧・現在停止中）**: Make.com → Pipedream（いずれも無料枠超過により運用停止）
- **Edge Function デプロイ事前検査**: `scripts/check-and-deploy-edge.sh`（`a8422fb`）。`deno check` で TS2304 系（未定義変数）を検知し、見つかれば deploy 中止
- **Testing**: Vitest, React Testing Library, MSW (Mock Service Worker)。`scripts/verify_email_extraction.mjs` でメール抽出ロジックのリグレッション検証
- **Deployment**: Vercel (Frontend), Supabase (Backend)
- **HF Spaces（品質チェック・計画中）**: Supabase pg_cron から呼び出す非同期品質チェック基盤。**絶対の掟: CPU のみ・無料枠のみ・GPU 使用禁止・有料プラン禁止**。UI からは参照しない（HF Spaces のみが参照）。Word/Excel のパース済み JSON を `candidates.raw_profile` に保存しておき、HF Spaces が定期的に取得して検証する。PDF 対応も HF Spaces 側で `pymupdf` を使って実装予定（現時点では PDF 受信実績ゼロのため後回し）

---

## 3. 開発フェーズ一覧（詳細は [docs/PHASES.md](docs/PHASES.md) 参照）

| Phase | 内容 | 状態 |
|---|---|---|
| 0〜3 | リポジトリ準備・DB基盤・コアロジック・UI実装 | ✅ 完了 |
| 4 | Make.com 連携（現在停止中） | ✅ 完了 |
| 4.5 | Microsoft Graph API ポーリング移行（稼働中） | ✅ 完了 |
| 4.6 | Microsoft OAuth UI 連携 | ✅ 完了 |
| 4.7 | Box 連携（人間手作業待ち） | ✅ 実装完了 |
| 4.8 | skill_master スキルマスター | ✅ 完了 |
| 4.9 | inbound-email AI 完全廃止 | ✅ 完了 |
| 4.10 | マッチング全面再設計（match-batch 導入） | ✅ 完了 |
| 4.11 | UI 統一・デモ生成ルールベース化 | ✅ 完了 |
| 4.12 | 人材マップ（ヒートマップ）・7 日アーカイブ | ✅ 完了 |
| 4.13 | マッチング SQL 化・ウェイト可変・地方加点 | ✅ 完了 |
| 4.14 | Issue 連携・station_master DB 化・抽出精度改善 | ✅ 完了 |
| 5 | 最終納品ドキュメント | 進行中 |

---

## 4. Claude Code 操作権限ポリシー

### 確認なしで即実行してよい操作（常識的な開発作業）

| カテゴリ | 具体例 |
|---|---|
| ファイル読み書き | Read / Edit / Write（ソースコード・設定・ドキュメント） |
| TypeScript ビルド確認 | `npx tsc --noEmit` |
| テスト実行 | `npm test` / `npx vitest run` |
| 依存パッケージ追加 | `npm install <package>` |
| Edge Function デプロイ | `bash scripts/check-and-deploy-edge.sh <function>` |
| Git 操作（通常） | `git add` / `git commit` / `git push`（main ブランチへの通常 push） |
| GitHub Issue 操作 | Issue 作成・クローズ（PATCH via Edge Function） |
| Supabase SQL 実行 | migration ファイルの `supabase db query --linked -f <file>` |
| ログ・状態確認 | `git status` / `git log` / `git diff` |

### 必ず確認してから実行する操作（破壊的・不可逆・広範囲に影響）

| カテゴリ | 具体例 |
|---|---|
| 強制 push | `git push --force` / `git push --force-with-lease` |
| ブランチ削除 | `git branch -D` |
| 大量削除 | `rm -rf` / DB テーブル DROP / `DELETE` 条件なし |
| 本番データ変更 | Supabase prod テーブルへの直接 UPDATE / INSERT（migration 以外） |
| 環境変数・Secrets 変更 | Supabase Secrets の追加・変更・削除 |
| 外部サービス設定変更 | Azure / GitHub / Vercel の設定変更 |
| 課金が発生する操作 | 有料 API の大量呼び出し・プラン変更 |

---

## 6. Claude Codeへの重要な行動指針
- **正の所在**: 仕様・挙動の優先順位は **本リポジトリのソース** と **`README.md`**。本ファイル（`CLAUDE.md`）はそれに追従するメモであり、食い違いがあれば **ソースを正として本ファイルを更新**すること。
- **こまめな Git 操作**: 機能実装単位、またはテスト通過ごとに、意味のあるメッセージと共に **commit & push** を行うこと。
- **バグゼロの追求**: ロジックには必ずテストコードを付随させ、テスト項目書をエビデンスとして出力すること。
- **ドキュメントの対象読者**:
  - README/構成図は「後任エンジニア」が最短で再現できるように。
  - 操作マニュアルは「非IT営業職」がIT用語なしで理解できるように。
- **Issue 作業サイクル（自律ループ）**:
  1. GitHub Issue リストを取得（`node scripts/list_issues.mjs`）して open な Issue を確認する
  2. open Issue をすべて実装・修正・テストし、commit & push する
  3. 修正が完了した Issue を `node scripts/list_issues.mjs --close <番号>` でクローズする
  4. 残った open Issue がないか再度取得する。新しい Issue があれば 1. に戻る
  5. open Issue が 0 件になったら完了を報告して待機する
  - **ユーザーへの確認不要**: 上記サイクルはユーザーが明示的に止めない限り自律的に続ける
- **ローカル検証スクリプト（使えるときは積極的に使うこと）**:
  - `node scripts/list_issues.mjs` — GitHub Issue 一覧取得・クローズ。Edge Function を直接叩くより高速
  - `node scripts/list_issues.mjs --close <番号>` — Issue クローズ（PATCH）
  - `node scripts/test_extraction.mjs "本文"` — regex 変更を **デプロイなし** でローカル検証。regex・フィールド抽出・複数人分割を即確認できる。変更前後の動作確認に必ず使うこと
  - `node scripts/check_extraction.mjs` — 直近14日の取りこぼし（name不明/NULLフィールド/誤登録）を Supabase から取得してローカル表示。品質チェックや `PROJECT_SOLICITATION_KEYWORDS` 追加前の調査に使う
  - `bash scripts/check-and-deploy-edge.sh <function>` — deno check + deploy を一括実行。Edge Function デプロイは必ずこれを使う
- **スキルの活用（使えるときは積極的に使うこと）**:
  - `/issue-loop` — Issue 自律修正ループ（fetch→実装→close→refetch）
  - `/deploy-edge` — Edge Function のデプロイ一括実行
  - `/quality-check` — skill_master メンテ・駅名マッピング・取りこぼし調査・異常監視・AIコスト監視

---

## 7. データベース構成

`candidate_skills` のカテゴリ CHECK 制約は **`supabase/migrations/add_candidate_skills.sql` を正**とする。

### テーブル一覧
| テーブル | 用途 |
|---|---|
| `candidates` | 人材マスタ。スキル・経歴・raw_profile を保持。**`data_env`**（`prod` \| `demo`）で論理分離。<br>主要カラム: `box_url`, `box_status`, `resume_url`, `drive_url`, `desired_rate`, `from_company`, `duplicate_flag`, `merged_into` |
| `projects` | 案件マスタ。必要スキル・予算・raw_data を保持。**`data_env`** 同上 |
| `submissions` | マッチング提案履歴。スコア・AI要約を保持。**`data_env`** 同上 |
| `candidate_skills` | スキルをカテゴリ別に分解して保持（検索最適化・14カテゴリ） |
| `candidates_archive_light` | **人材マップ用サマリーテーブル**（Phase 4.12）。7 日経過した prod 人材の `id`/`data_env`/`prefecture`/`skills`/`created_at`/`archived_at` + `name`/`subject` を保持。`archive-candidates` Edge Function が毎日 JST 0:00 に upsert + 元データ削除 |
| `ai_logs` | AI解析の実行ログ（モデル・所要時間・結果・エラー）。メール解析の AI 廃止後、`inbound-email` 由来のレコードは `model='no-ai'` で保存される |
| `error_logs` | フロントエンド側のクライアントエラーを記録（コミット `a2c0e96`）。`page`/`message`/`stack`/`context`/`data_env`/`nickname` を保持。`saveErrorLog`/`logError` ユーティリティから呼び出し。30 日自動削除 cron は未実装（要追加） |
| `skill_master` | ITスキルマスタ。約 1,660 件規模（acf9d31 で +32 件、Phase 4.10 で DWH/工程/IBM 系を +32 件追加）。aliases で表記ゆれ吸収・match_count / last_matched_at でマッチ実績管理 |
| `station_master` | **駅名 → 都道府県マッピング**（Phase 4.14 / コミット `0f28327`）。全国 1,797 駅。`id`/`name`/`prefecture`。`inbound-email` が起動時にロードして関数インスタンス内にキャッシュ（`_stationDbMap`）。RLS は読み取り全許可 |
| `relevance_keywords` | 関連性キーワード辞書（`exclude` / `candidate` / `project` の 3 種別）。`classifyInboundRelevance` で使用予定だったがコミット `a4dc3b4` で関数自体が削除されたため、現状の `inbound-email` 経路では未使用 |
| `app_config` | アプリ全体設定。Microsoft OAuth リフレッシュトークンのローテーション保存・各種機能フラグも保持（後述） |

### app_config の主要キー
| キー | 既定 | 内容 |
|---|---|---|
| `inbound_project_enabled` | `false` | 案件メールの解析と DB 保存を有効化 |
| `auto_match_enabled` | `true` | `auto-match` cron を有効化。`'false'` でスキップ |
| `email_poll_mode` | `incremental` | `incremental`（未読のみ）か `full`（指定日以降全件） |
| `email_full_import_since` | （未設定） | `full` モード時の開始 ISO 日時 |
| `email_classify_enabled` | `false` | `poll-email` 内の Gemini メール種別分類 |
| `matching_run_mode` | `fast` | **既定マッチング実行モード**（`fast` / `full`）。SettingsPage の「マッチング実行モード」セクションから変更 |
| `matching_fast_max_candidates` | `20` | 高速モード時の案件あたり候補者上限（1〜200 で UI から変更可） |
| `matching_fast_max_projects` | `10` | 高速モード時の人材あたり案件上限（1〜200 で UI から変更可） |
| `candidate_retention_days` | `7` | 人材データ保持日数（`archive-candidates` cron が参照） |
| `app_memo` | （未設定） | 営業引き継ぎ用フリーテキストメモ |
| `graph_rt_human_prod` ほか | — | Microsoft OAuth 連携で保存されるリフレッシュトークン（4 アカウント分） |

### candidate_skills の14カテゴリ
| カテゴリ | 内容 |
|---|---|
| `languages` | プログラミング言語・クエリ言語 |
| `frameworks` | フレームワーク |
| `libraries` | ライブラリ、UIキット等 |
| `os` | OS |
| `databases` | RDB・NoSQL・KVS |
| `dwh` | DWH・BI 等 |
| `clouds` | クラウドサービス |
| `infrastructures` | インフラ技術（コンテナ・IaC 等） |
| `tools` | Git, Jira, Slack, Notion, BIツール等 |
| `methodologies` | PM・マネジメント系 |
| `certifications` | 資格試験等 |
| `design` | デザイン・クリエイティブ系 |
| `marketing` | マーケティング・集客系 |
| `others` | その他 |

---

## 8. 実装済み機能の詳細

### メール自動受信（現行・ポーリング方式）

```
pg_cron（5分ごと）
  ↓
【poll-email】メール取得係
  - Microsoft Graph API で Outlook の未読メールを取得
  - AI種別判断（有効時）: candidate / project / other を判定
  - 処理済みメールを既読マーク（重複防止）
  - メール内容を inbound-email に HTTP POST で渡す（1件ずつ）
  ↓
【inbound-email】解析・保存係（AI不使用・regex + skill_master DB照合）
  - STEP0-2: メタ情報・本文・添付の受け取りと検証
  - STEP3:   Word/Excel 添付をテキスト変換（PDF は Storage 保存のみ）
  - STEP4:   メール本文中の Google Drive / Sheets / Docs リンクを取得
  - STEP5:   regex + 文章スキャン + skill_master DB 照合で構造化抽出
             - 人材経路: HTMLエンティティ復号 → URL除去 → 署名除去 → skill_master照合 →
               extractCandidateFieldsRegex → 駅→都道府県 → extractFromProse →
               splitMultiCandidateBody → 重複判定
             - 案件経路: 同じ前処理 → extractFieldTwoPhase → 【内容】セクション抽出 →
               駅→都道府県 → スキル抽出（尚可セクション分離）
  - STEP6-7: 解析結果を candidates / projects テーブルに DB 保存（ai_logs.model='no-ai'）
  - STEP8:   任意・AUTO_MATCH_ENABLED='true' のとき matchCandidateToProject 経由で即時マッチ
```

- **メールアドレス**: 人材用 `akinavi.hr.ai.voice.human@outlook.jp` / 案件用 `akinavi.hr.ai.voice.project@outlook.jp`
- **案件メール処理**: `app_config.inbound_project_enabled='true'` のときのみ実行（既定 OFF）
- **手入力登録**: `force=true` で DEDUP / SENDER_DAILY_LIMIT / `inbound_project_enabled` ゲートをバイパス

### メール設定UI（`src/pages/SettingsPage.tsx`）
- メールアドレス設定を app_config に保存（参照用）
- AI種別判断（有効時）: Gemini で `candidate` / `project` / `other` を自動分類（既定 OFF）
- 全件取り込みモード UI は削除済み。必要なら SQL Editor で `email_poll_mode='full'` / `email_full_import_since` を手動設定

### Edge Function `inbound-email` の主要フラグ
- **`inbound_project_enabled`**: `true` で案件メールを解析（既定 OFF）
- **`AUTO_MATCH_ENABLED`** (env): `true` で即時マッチを有効化（既定 false）
- **`force=true`** (body): DEDUP / SENDER_DAILY_LIMIT ゲートをバイパス（手入力登録ボタン経由）

### 論理データ環境 `data_env`
- `prod` / `demo` を同一Supabase内で分離（`data_env` カラムでフィルター）
- 初回解除: `VITE_DEMO_KEY` と URL クエリ `?demo=<鍵>` でトグル
- 以降の切替: SettingsPage の「デモモード」スイッチ
- デモ UI 未解除時は常に `prod` 固定

### マッチング方式

| | 高速モード（fast） | 全件モード（full） | 自動バッチ（daily cron） |
|---|---|---|---|
| **実行タイミング** | 手動 | 手動 | 毎朝 JST 9:00 |
| **AI 呼び出し** | `match-batch`（topN 一括採点） | 同上 | 同上 |
| **AI フォールバック** | Cerebras→Groq 70B→Gemini | 同上 | 同上 |

#### スコア配点（既定ウェイト 100pt）
ルールスコア計算は `fetch_candidates_for_project` RPC（SQL 側）で完結。`match-batch` は SQL 結果に対して AI 採点のみ実施。

| 観点 | 既定ウェイト | 備考 |
|---|---|---|
| スキル一致 | 40pt | 必須スキル合致比率 × 40。required 空時は固定 20pt。歓迎スキル +0.1 ボーナス（上限 40pt） |
| 経験年数 | 15pt | 10年=15 / 7年=12 / 5年=8 / 3年=4 / 1年=2 / 不明=5（中間点） |
| 単価 | 15pt | 予算未設定 +15、範囲内 +15、上限+10% +8、上限+20% +3 |
| 勤務地 | 20pt | フルリモート/同一都道府県 +20 / 同一地方 +10 / 居住地不明 +5 / 不一致 0 |
| リモート | 10pt | リモート可・希望時 +10 |

- **スキル全不一致時の上限 35pt**
- **フルリモート希望 × 常駐案件は 30pt 上限**
- **ウェイト可変**: `p_weight_skill` / `p_weight_exp` / `p_weight_rate` / `p_weight_location` / `p_weight_remote`
- AI は topN 件（既定 10 件）のみ採点。出力コメントは 120 字以内・スコア数値禁止

### デモ生成（AI 不使用・ルールベース）
- `DemoSeedPanel`: テンプレ生成・本番→デモコピー（random/recent）・デモメール再解析
- `DemoProjectCandidateGen`: 選択中案件ベースのスコア別 5 人生成（90/70/50/30/10pt 想定）
- 本番→デモコピー時は email を `demo.prod+<uuid>@demo.invalid` に変換、`resume_url`/`box_url` を除去
- 表示条件: `demoUiEnabled === true` のみ（dataEnv 不問）

### 画面構成
- ナビゲーションタブは **4 つ**: `マッチング` / `人材` / `案件` / `設定`（`src/components/Layout.tsx` の `NAV_ITEMS` を正とする）
- **「人材マップ」**: 「人材」タブ内のサブ画面。`CandidatePage` の「人材マップ」ボタン（`MapIcon`）→ `onOpenHeatmap` で遷移
- **`設定` タブ**: メール設定 / Microsoft 連携 / 案件メール解析 / 自動マッチング / マッチング実行モード / GitHub Issue / デモモード / データ削除
- `人材マップ` 画面: `src/pages/HeatmapPage.tsx`。詳細は [`docs/Heatmap.md`](docs/Heatmap.md) 参照
- `提案履歴` / `重複管理` / `解析監視` は実装済みだがナビから非表示（`HistoryPage.tsx`, `DuplicatePage.tsx`, `MonitorPage.tsx`）

### CandidatePage の主要機能
- **登録**: `inbound-email` を `force=true` で呼び出し（regex + skill_master 方式）
- **再解析**: `raw_profile.text` を本文として `inbound-email` に再投入
- **検索スコープ**: `tags` / `body` / `all` の 3 モード（`search_candidates(p_scope)` RPC）
- **返信**: `mailto:` の body に元メール本文先頭 800 字を引用
- **エージェントコメント**: `raw_profile.agentComment` を黄色枠で表示

### ファイルアップロード解析（`src/lib/fileParser.ts`）
- **Excel（.xlsx/.xls）**: `xlsx`（SheetJS）で全シートを CSV 変換
- **Word（.docx）**: `mammoth` で本文テキスト抽出
- **PDF・画像**: 現状未対応。「テキストを手動貼り付け」を案内

### Google Drive / Sheets / Docs 自動取得
- `fetchGoogleLinks` でメール本文中のリンクを自動検出・取得
- Sheets → CSV、Docs → txt、Drive PDF → base64化して解析対象に追加
- 認証不要（リンクを知っている全員が閲覧可の共有設定前提）

### AI プロバイダー
- **ブラウザ**: Gemini（既定 `gemini-2.5-flash-lite`）。人材・案件登録 UI からは呼ばない
- **サーバー（match-batch / match-score / auto-match）**: Cerebras `llama3.1-8b` → Groq `llama-3.3-70b-versatile` → Gemini `gemini-2.5-flash`（3段フォールバック、全失敗時はルールスコアで全代替）
- **サーバー（poll-email 種別分類）**: Gemini `gemini-2.5-flash-lite`（任意・既定 OFF）
- **inbound-email**: AI 不使用

### Edge Function デプロイ
- **必ずこれを使う**: `bash scripts/check-and-deploy-edge.sh <function>`（`deno check` → TS2304 未定義変数を検知してデプロイ中止）
- `npm run deploy:edge <function>` でも可（既定 `inbound-email`）

### 品質チェック（`/quality-check` コマンド）
- ① 駅マッピング: `[station_unmapped]` ログ → `station_master` テーブルに INSERT（コード変更不要）
- ② スキルマスタ: `scripts/skill_master_review.py` で怪しいエントリの削除候補 SQL を出力
- ③ 誤登録パターン検出: `TRAINING_REPORT` / `PROJECT_SOLICITATION` の `[SKIP_IRRELEVANT]` ログ確認
- ④ 重複候補者の手動マージ判定
- ⑤ AI コスト監視: `ai_logs` でモデル別・日次呼び出し数を集計
- ⑥ GitHub Issue 整理: 設定タブの一覧から対応済みをクローズ

### その他
- **認証**: ログイン機能なし。ニックネームを `localStorage` に保存
- **データ重複管理**: email 一致時は自動 UPDATE。名前一致 + スキル Jaccard ≥ 0.4 で `duplicate_flag=true`（自動マージ不可）。駅違いは別人扱い
- **ai_logs**: 全 AI 呼び出しを記録。`inbound-email` は `model='no-ai'` で記録（後方互換）
- **error_logs**: `saveErrorLog`/`logError` でフロントエラーを保存。30 日自動削除 cron は未実装（要追加）
