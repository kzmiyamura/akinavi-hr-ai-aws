# プロジェクト概要: AkiNavi HR-AI（アキナビ HR-AI）

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。
バグゼロを目指した徹底的なテスト、こまめなGit管理、および将来の担当者が即座に再現可能なドキュメント完備をゴールとする。

## 2. 技術スタック
- **Frontend**: React 19 (Vite 8), TypeScript, Tailwind CSS v4, TanStack Query v5
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, Realtime)
- **AI（ブラウザ）**: Google Gemini デフォルト `gemini-2.0-flash`（`VITE_GEMINI_MODEL` で上書き可。旧 `gemini-1.5-flash-8b` は API 非対応）
- **AI（サーバー・自動取り込み）**: Google Gemini `gemini-2.5-flash` — **Supabase Edge Function `inbound-email` のみ**（旧 Vercel `api/analyze` は移設済み・本番 Webhook では未使用）
- **AI（切替・フロントのみ）**: `VITE_AI_PROVIDER=gemini` / `openai` — OpenAI は `openaiProvider.ts` が未実装スタブ
- **Email**: Outlook 専用アカウント + **Make.com**（Inbound Webhook → Edge `inbound-email`）。Make は **Free でも月次オペレーション上限**があり、本番負荷では枠切れや有料プラン・代替連携の検討が必要
- **Testing**: Vitest, React Testing Library, MSW (Mock Service Worker)
- **Deployment**: Vercel (Frontend), Supabase (Backend)

## 3. 開発・品質管理工程表（人間とClaude Codeの共同作業）

### 【Phase 0】リポジトリ準備・初期化・インフラ開通 ✅
1. **[人間] 手作業**: GitHubでPrivateリポジトリ作成、Vercelインポート、APIキー取得
2. **[Claude] 作業**: Vite + React + TypeScriptプロジェクト初期化、主要ライブラリインストール、Git初期化・push

### 【Phase 1】DB基盤と環境構築 ✅
1. **[Claude] 作業**: jsonbとGINインデックスを用いた汎用DB設計(SQL)の提示
2. **[人間] 手作業**: SupabaseでSQL実行、.env / Vercel環境変数の設定
3. **[Claude] 作業**: 接続確認後、DBスキーマ定義をcommit & push

### 【Phase 2】コアロジック開発 ＆ 単体テスト ✅
1. **[Claude] 作業**: AI解析エンジン（Edge Functions）およびスコアリングロジックの実装
2. **[Claude] 開発**: 単体テスト (Unit Test) の記述
3. **[Claude] 作業**: テスト通過を確認し、commit & push

### 【Phase 3】UI実装 ＆ 結合テスト ✅
1. **[Claude] 作業**: ランキング表示、マッチング画面、提案履歴機能の実装
2. **[Claude] 開発**: 結合テスト (Integration Test) の記述
3. **[人間] 手作業**: 実際のメールデータを用いた解析・マッチング精度の最終検証
4. **[Claude] 作業**: 完了後、commit & push

### 【Phase 4】自動化・デプロイ・改善 ✅（継続中）
1. **[Claude] 作業**: Make.com (Outlook) と連携した自動解析フローの実装
   - フロー: メール受信 → Make.com が検知 → **Supabase Edge Function `inbound-email`**（解析API） → Gemini AI 解析 → DB 保存
   - サーバー側解析は **Supabase Functions に移設済み**（Vercel Serverless の `api/analyze` はレガシー）
   - 人材用メール: `akinavi.hr.ai.voice.human@outlook.jp`
   - 案件用メール: `akinavi.hr.ai.voice.project@outlook.jp`
2. **[Claude] 作業**: AI解析精度の継続的改善（プロンプトチューニング）
3. **[Claude] 作業**: Google Drive / Sheets / Docs リンクの自動取得機能実装

### 【Phase 5】最終納品ドキュメント作成（一部未着手）
1. **[Claude] 作業**: システム構成図のメンテナンス（`README.md` に Mermaid 図あり。詳細アーキテクチャが必要なら追記）
2. **[Claude] 作業**: 操作マニュアルのメンテナンス（`docs/Sales_Manual.md` / `docs/Sales_Manual.pdf`・営業担当者向け）
3. **[Claude] 完了**: 全成果物を commit & push し、納品完了

---

## 4. Claude Codeへの重要な行動指針
- **正の所在**: 仕様・挙動の優先順位は **本リポジトリのソース** と **`README.md`**。本ファイル（`claude.md`）はそれに追従するメモであり、食い違いがあれば **ソースを正として本ファイルを更新**すること（`CLAUDE.md` と内容を揃えること）。
- **こまめな Git 操作**: 機能実装単位、またはテスト通過ごとに、意味のあるメッセージと共に **commit & push** を行うこと。
- **バグゼロの追求**: ロジックには必ずテストコードを付随させ、テスト項目書をエビデンスとして出力すること。
- **ドキュメントの対象読者**:
  - README/構成図は「後任エンジニア」が最短で再現できるように。
  - 操作マニュアルは「非IT営業職」がIT用語なしで理解できるように。

## 5. データベース構成

`candidate_skills` のカテゴリ CHECK 制約は **`supabase/migrations/add_candidate_skills.sql` を正**とする。`schema.sql` と定義が食い違う場合があるため、新規環境ではマイグレーション適用後の状態を確認すること。

### テーブル一覧
| テーブル | 用途 |
|---|---|
| `candidates` | 人材マスタ。スキル・経歴・raw_profile を保持。**`data_env`**（`prod` \| `demo`）で論理分離 |
| `projects` | 案件マスタ。必要スキル・予算・raw_data を保持。**`data_env`** 同上 |
| `submissions` | マッチング提案履歴。スコア・AI要約を保持。**`data_env`** 同上 |
| `candidate_skills` | スキルをカテゴリ別に分解して保持（検索最適化・**14カテゴリ**・上記マイグレーション準拠） |
| `ai_logs` | AI解析の実行ログ（モデル・所要時間・結果・エラー） |
| `app_config` | アプリ全体設定 |

### candidate_skills の14カテゴリ（マイグレーション準拠）
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

## 6. 追加要件（実装済み）

### メール自動受信の方針
- **採用**: Outlook（専用アカウント）+ Make.com（Webhook で **Supabase Edge Function `inbound-email`** を POST）
- Make は **無料枠にオペレーション上限**がある（「完全無料で無制限」ではない）。詳細は Make ダッシュボードの Usage を正とする
- フロー: メール受信 → Make が検知 → **`inbound-email`** → Gemini 解析 → DB 保存（サーバー側解析はこの Edge のみ）
- 人材用メール: `akinavi.hr.ai.voice.human@outlook.jp`
- 案件用メール: `akinavi.hr.ai.voice.project@outlook.jp`
- Edge の `type` で人材／案件を振り分け（`type=candidate` / `type=project`）。POST は **form-urlencoded または JSON**（`README.md` のパラメータ表を正とする）
- **`from`**: プレーンなメール文字列に加え、**Microsoft Graph 形式の JSON 文字列**も `inbound-email` 内 `parseFrom` で解釈可能（Power Automate 等への置き換え時の手がかり）

### Edge `inbound-email`（`supabase/functions/inbound-email/index.ts` 準拠）
- **データ環境**: ボディまたはクエリの `mode` / `data_env`（`prod` | `demo` | `dev` ※ `dev` は `demo` と同扱い）。省略時は `prod`。URL クエリ `?mode=demo` やヘッダ `X-Data-Env` / `X-Mode` も補完に利用
- **Secrets 例**: `GEMINI_API_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。**`GEMINI_INBOUND_TIMEOUT_MS`**: 1 回の Gemini 待ち上限（15〜300000 ms、未設定時 38000）。全体の壁時計は Edge プランにより **概ね 150〜400 秒程度**
- **その他 Secrets / フラグ（コメント参照）**: `INBOUND_RELEVANCE_CHECK`、`INBOUND_MAKE_SOFT_FAIL`（例外時も HTTP 200 + `ok:false` で Make 停止しにくくする）、`INBOUND_BODY_FALLBACK_ON_GEMINI_TIMEOUT` など
- 本文・添付とも空: **HTTP 200 + skipped**（Webhook 連携継続向け）。添付は README 記載のキー（例: `attachment[data]` 等）

### 論理データ環境 `data_env`（DB・アプリ）
- **`supabase/migrations/add_data_env.sql`**: `candidates` / `projects` / `submissions` に `data_env text NOT NULL`、CHECK は **`prod` | `demo`**
- **フロント**: `src/lib/dataEnv.ts` の `DataEnv`（`prod` | `demo`）、`localStorage` の **`akinavi.dataEnv.v1`**（選択中環境）と **`akinavi.demoUnlock.v1`**（デモ UI 解除フラグ）。**デモ解除**は `VITE_DEMO_KEY` と URL クエリ `?demo=`（`demoKey` / `demo_key` も可）のトグル（`applyDemoKeyFromUrlToggle`）と連動
- クエリ・更新は各ページで **`dataEnv` を渡し**、本番データとデモデータを同一 Supabase 内で分離

### デモと本番の切り替えモード（ブラウザ・`App.tsx` / `Layout.tsx` / `src/lib/dataEnv.ts` 準拠）
- **目的**: 同一 Supabase 上の **`data_env` = `prod` / `demo`** を、ブラウザごとにどちらを見るか切り替える（本番データの誤操作を避けつつ営業デモ用データを使う）
- **既定（デモ UI 未解除）**: **`本番相当（prod）` のみ**。`localStorage` に `demo` が残っていても起動時は **`prod` に読み替え**。ヘッダに環境セレクトは**出ない**
- **解除（デモ／本番の切替を有効化）**: **`VITE_DEMO_KEY`** がビルドに設定されている前提で、**`?demo=<鍵>`** で開く（`demoKey` / `demo_key` クエリ名も可・`parseDemoKeyFromLocation`）。鍵が一致すると **`akinavi.demoUnlock.v1` = オン**、ヘッダに **「データ」セレクト**（`Layout.tsx`）が表示される。初回成功時は環境を **`demo` にし**、鍵クエリは URL から除去
- **再ロック（本番固定に戻す）**: **既に解除済み**の同一ブラウザで、**同じ正しい `?demo=` 付き URL を再度開く**と **`applyDemoKeyFromUrlToggle` がトグル**し、解除フラグがオフ・**`prod` 固定**・セレクト非表示（営業後にデモ切替を閉じる用途）
- **鍵が空／不一致**: 処理しない、またはクエリだけ除去（**`VITE_DEMO_KEY` 未設定**では有効な鍵にならない）
- **セレクト表示中**: 「**本番相当（prod）**」「**デモ（demo）**」を選ぶと **`akinavi.dataEnv.v1`** が更新され、**全画面の取得・更新はその `data_env` の行のみ**を対象にする
- **解除がオフになったあと `demo` を選んでいた場合**: `demoUiEnabled === false` なら **`demo` を `prod` に自動補正**
- **コンポーネント別**: **`demoUiEnabled`** を渡すのは主に人材・案件ページ（デモ用パネル等）。**`MatchingPage` は `dataEnv` のみ**（マッチングも選択中環境のデータのみ）

### マッチング画面（`src/pages/MatchingPage.tsx` 準拠）
- **実行モード**: `fast`（高速）/ `full`（全件）。選択は **`localStorage` キー `akinavi.matchingRunMode.v1`**
- **高速モードの上限（定数）**: 案件あたり候補 **最大 20 名**（`FAST_MAX_CANDIDATES_PER_PROJECT`）、人材あたり案件 **最大 10 件**（`FAST_MAX_PROJECTS_PER_CANDIDATE`）。必須スキル重複が多い順に優先
- **進捗**: 一括・行単位の再実行とも **何件目か**を表示。`flushSync` でループ中の `setState` を確実に描画。長い一覧では **sticky** の進捗カード＋**行内**の進捗文
- **一括マッチング（全案件／全人材）**: **`bulkCancelRequestedRef`** により **キャンセル可能**（各組み合わせの区切りで打ち切り。**進行中の 1 件の AI 応答は完了まで待つ**）。完了分は保存済みとしてメッセージ表示

### デモシード（`src/components/DemoSeedPanel.tsx`）
- デモ環境向けに **人材・案件のサンプルペア**を DB 投入（架空だが実務に近い文言・スキル構成。`AnalyzeCandidateResponse` / `AnalyzeProjectResponse` 形状で投入）

### アプリシェル（`src/App.tsx` 準拠）
- **マッチング**タブを非表示にしても **`MatchingPage` はアンマウントしない**（`hidden` で切替）。長時間の一括マッチング mutation がタブ移動で中断されないため

### Google Drive / Sheets / Docs 自動取得
- メール本文中の Google Drive・Sheets・Docs の共有リンクを自動検出
- Sheets → CSV export、Docs → txt export、Drive PDF → base64化してGeminiに渡す
- 認証不要（「リンクを知っている全員が閲覧可」の共有設定前提）
- 取得失敗は無視してフォールバック

### AI プロバイダー抽象化
- **ブラウザ（Vite）**: Gemini（既定 `gemini-2.0-flash`、`VITE_GEMINI_MODEL` / `VITE_GEMINI_API_KEY`）
- **サーバー（Edge `inbound-email` のみ）**: Gemini `gemini-2.5-flash`（Supabase Secrets の `GEMINI_API_KEY`）
- **フロントの切替**: `.env.local` 等で `VITE_AI_PROVIDER=gemini`（デフォルト）または `openai` — 後者はスタブで未実装
- **サーバー側**: 現状 Gemini 固定（OpenAI 切替なし）
- フロントの AI 呼び出しは `AIProvider` インターフェースで抽象化

### 認証なし・ニックネーム制
- ログイン機能は持たない
- 初回アクセス時に「利用者のニックネーム」を入力させ、`localStorage` に保存

### 画面構成（現状）
- タブは **3つに整理**（運用をシンプルにするため、他タブは一旦非表示）
  - `マッチング結果`（初期表示）
  - `人材登録`
  - `案件登録`
- `提案履歴` / `重複管理` / `解析監視` は実装が残っていても **ナビからは非表示**

### データ重複管理
- **email が同じ**場合は自動で既存レコードを **UPDATE**（上書き更新）
- **AI が「名前やスキルが似ている」と判断**した場合は `duplicate_flag = true` を立てるだけ（自動マージ不可）

### AI解析ログ（ai_logs）
- 全AI解析呼び出しをDBに記録（モデル名・所要時間ms・結果JSON・エラー）
- 成功・失敗どちらもログに残す
