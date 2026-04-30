# プロジェクト概要: AkiNavi HR-AI (アキナビ HR-AI)

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。
バグゼロを目指した徹底的なテスト、こまめなGit管理、および将来の担当者が即座に再現可能なドキュメント完備をゴールとする。

## 2. 技術スタック
- **Frontend**: React 18 (Vite), TypeScript, Tailwind CSS, TanStack Query
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, Realtime)
- **AI**: Google Gemini 1.5 Flash（メイン・無料枠）/ OpenAI GPT-4o（切替可）
- **Email**: Gmail（専用アカウント）+ Google Apps Script（Inbound Webhook）
- **Testing**: Vitest, React Testing Library, MSW (Mock Service Worker)
- **Deployment**: Vercel (Frontend), Supabase (Backend)

## 3. 開発・品質管理工程表（人間とClaude Codeの共同作業）

### 【Phase 0】リポジトリ準備・初期化・インフラ開通
1. **[人間] 手作業**: 
   - GitHubでPrivateリポジトリ `akinavi-hr-ai` を作成（README/gitignore等はOFF）。
   - VercelでGitHubリポジトリをインポートし、プロジェクトの枠組みを作成。
   - ResendおよびOpenAIの管理画面からAPIキーを取得。
2. **[Claude] 作業**: 
   - Vite + React + TypeScript プロジェクト初期化。
   - **主要ライブラリ一括インストール**:
     - UI: `tailwindcss`, `postcss`, `autoprefixer`, `lucide-react`
     - State/Data: `@tanstack/react-query`, `@supabase/supabase-js`
     - Testing: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `msw`
     - API/Email: `resend` (SDK)
   - **環境設定ファイルの生成**:
     - セキュリティを考慮した `.gitignore`。
     - 必要なAPIキーを網羅した `.env.example`。
   - Git初期化、リモート登録、最初の **commit & push**。

### 【Phase 1】DB基盤と環境構築
1. **[Claude] 作業**: `jsonb`と`GINインデックス`を用いた汎用DB設計(SQL)の提示。
2. **[Claude] 依頼**: 人間に「SupabaseでのSQL実行」と「.env / Vercel環境変数の設定」を依頼。
3. **[人間] 手作業**: 各環境変数の入力とDBテーブル作成。
4. **[Claude] 作業**: 接続確認完了後、DBスキーマ定義をリポジトリへ **commit & push**。

### 【Phase 2】コアロジック開発 ＆ 単体テスト
1. **[Claude] 作業**: AI解析エンジン（Edge Functions）およびスコアリングロジックの実装。
2. **[Claude] 開発**: ロジックに対する **単体テスト (Unit Test)** の記述。
3. **[Claude] 成果物**: **「単体テスト項目書 兼 結果報告書」** をMarkdownで出力。
4. **[Claude] 作業**: テスト通過を確認し、**commit & push**。

### 【Phase 3】UI実装 ＆ 結合テスト
1. **[Claude] 作業**: ランキング表示、マッチング画面、提案履歴機能の実装。
2. **[Claude] 開発**: 画面間連携を確認する **結合テスト (Integration Test)** の記述。
3. **[Claude] 成果物**: **「結合テスト項目書 兼 結果報告書」** をMarkdownで出力。
4. **[人間] 手作業**: 実際のメールデータを用いた解析・マッチング精度の最終検証。
5. **[Claude] 作業**: 完了後、**commit & push**。

### 【Phase 4】自動化・デプロイ・クリーンアップ
1. **[Claude] 作業**: Gmail + Google Apps Script と連携した自動解析フローの実装。
   - Resend は独自ドメインが必要なため不採用（コスト面）。
   - 専用 Gmail アカウントへの受信をトリガーに Apps Script → Supabase Edge Function を呼び出す。
2. **[Claude] 依頼**: 人間に「専用 Gmail アカウントの作成」と「Apps Script のデプロイ・権限付与」を依頼。
3. **[Claude] 作業**: 本番環境稼働前のテストデータ破棄（クリーンアップスクリプト実行）。
4. **[Claude] 作業**: 全体の疎通確認後、**commit & push**。

### 【Phase 5】最終納品ドキュメント作成
1. **[Claude] 作業**: **`readme.md`**（環境構築ガイド）の作成。
2. **[Claude] 作業**: **システム構成図**（Mermaid.js形式による全体フロー図）の作成。
3. **[Claude] 作業**: **操作マニュアル (Sales_Manual.md)** の作成（営業担当者向け）。
4. **[Claude] 完了**: 全成果物を **commit & push** し、納品完了。

---

## 4. Claude Codeへの重要な行動指針
- **こまめな Git 操作**: 機能実装単位、またはテスト通過ごとに、意味のあるメッセージと共に **commit & push** を行うこと。
- **バグゼロの追求**: ロジックには必ずテストコードを付随させ、テスト項目書をエビデンスとして出力すること。
- **ドキュメントの対象読者**: 
  - README/構成図は「後任エンジニア」が最短で再現できるように。
  - 操作マニュアルは「非IT営業職」がIT用語なしで理解できるように。

## 5. データベース構成
- 柔軟性確保のため `jsonb` を積極的に活用し、`candidates`, `projects`, `submissions`, `app_config` テーブルを構築。

## 6. 追加要件（Phase 1 DB設計に反映）

### メール自動受信の方針
- **採用**: Gmail（専用アカウント）+ Google Apps Script（完全無料）
- **不採用**: Resend Inbound（独自ドメインが必要でコストがかかるため）
- フロー: メール受信 → Power Automate が検知 → Supabase Edge Function を呼び出し → Gemini AI 解析 → DB 保存
- 人材用メール: `akinavi.hr.ai.voice.human@outlook.jp`
- 案件用メール: `akinavi.hr.ai.voice.project@outlook.jp`
- Edge Function の `type` パラメータで人材／案件を振り分け（`type=candidate` / `type=project`）

### AI プロバイダー抽象化
- **メイン**: Google Gemini 1.5 Flash（無料枠）
- **切替**: `.env` の `AI_PROVIDER=gemini` / `AI_PROVIDER=openai` で切り替え可能
- AI解析部分は `AIProvider` インターフェースで抽象化し、`GeminiProvider` / `OpenAIProvider` を実装する
- 環境変数: `GEMINI_API_KEY` / `OPENAI_API_KEY`

### 認証なし・ニックネーム制
- ログイン機能は持たない。
- 初回アクセス時に「利用者のニックネーム」を入力させ、`localStorage` に保存する。
- 全レコードの `created_by` カラムにそのニックネームを格納する。

### データ重複管理の強化
- **email が同じ**場合は、自動で既存レコードを **UPDATE**（上書き更新）する。
- **AI が「名前やスキルが似ている」と判断した**場合は、自動統合せず `duplicate_flag = true` を立てるだけにする。
  - 自動マージは行わない。必ず人間の判断を挟む。

### 名寄せ（マージ）機能（Phase 3 実装予定）
- Phase 3 で「ボタン一つでマージできる UI + ロジック」を実装する前提で DB を設計する。
- `candidates` テーブルに `duplicate_flag` (boolean) と `merged_into` (uuid, 参照先 candidate_id) カラムを持たせる。
- マージ済みレコードは `merged_into` に統合先 ID をセットし、論理削除扱いとする。