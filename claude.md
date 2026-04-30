# プロジェクト概要: AkiNavi HR-AI（アキナビ HR-AI）

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。
バグゼロを目指した徹底的なテスト、こまめなGit管理、および将来の担当者が即座に再現可能なドキュメント完備をゴールとする。

## 2. 技術スタック
- **Frontend**: React 18 (Vite), TypeScript, Tailwind CSS, TanStack Query
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, Realtime)
- **AI**: Google Gemini 2.5 Flash Lite（メイン・無料枠）/ OpenAI GPT-4o（切替可）
- **Email**: Outlook専用アカウント + Make.com（Inbound Webhook）
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
   - フロー: メール受信 → Make.com が検知 → Supabase Edge Function → Gemini AI 解析 → DB 保存
   - 人材用メール: `akinavi.hr.ai.voice.human@outlook.jp`
   - 案件用メール: `akinavi.hr.ai.voice.project@outlook.jp`
2. **[Claude] 作業**: AI解析精度の継続的改善（プロンプトチューニング）
3. **[Claude] 作業**: Google Drive / Sheets / Docs リンクの自動取得機能実装

### 【Phase 5】最終納品ドキュメント作成（未着手）
1. **[Claude] 作業**: システム構成図（Mermaid.js形式）の作成
2. **[Claude] 作業**: 操作マニュアル (Sales_Manual.md) の作成（営業担当者向け）
3. **[Claude] 完了**: 全成果物を commit & push し、納品完了

---

## 4. Claude Codeへの重要な行動指針
- **こまめな Git 操作**: 機能実装単位、またはテスト通過ごとに、意味のあるメッセージと共に **commit & push** を行うこと。
- **バグゼロの追求**: ロジックには必ずテストコードを付随させ、テスト項目書をエビデンスとして出力すること。
- **ドキュメントの対象読者**:
  - README/構成図は「後任エンジニア」が最短で再現できるように。
  - 操作マニュアルは「非IT営業職」がIT用語なしで理解できるように。

## 5. データベース構成

### テーブル一覧
| テーブル | 用途 |
|---|---|
| `candidates` | 人材マスタ。スキル・経歴・raw_profileを保持 |
| `projects` | 案件マスタ。必要スキル・予算・raw_dataを保持 |
| `submissions` | マッチング提案履歴。スコア・AI要約を保持 |
| `candidate_skills` | スキルを11カテゴリに分解して保持（検索最適化） |
| `ai_logs` | AI解析の実行ログ（モデル・所要時間・結果・エラー） |
| `app_config` | アプリ全体設定 |

### candidate_skills の11カテゴリ
| カテゴリ | 内容 |
|---|---|
| `languages` | プログラミング言語・クエリ言語 |
| `frameworks` | FW・ライブラリ |
| `os` | OS |
| `databases` | RDB・NoSQL・KVS |
| `dwh` | DWH・BIツール |
| `cloud` | クラウド・インフラ・コンテナ |
| `design` | デザイン・クリエイティブ系 |
| `marketing` | マーケティング・集客系 |
| `management` | PM・マネジメント系 |
| `business` | ビジネスツール |
| `others` | その他 |

## 6. 追加要件（実装済み）

### メール自動受信の方針
- **採用**: Outlook（専用アカウント）+ Make.com（完全無料）
- フロー: メール受信 → Make.com が検知 → Supabase Edge Function を呼び出し → Gemini AI 解析 → DB 保存
- 人材用メール: `akinavi.hr.ai.voice.human@outlook.jp`
- 案件用メール: `akinavi.hr.ai.voice.project@outlook.jp`
- Edge Function の `type` パラメータで人材／案件を振り分け（`type=candidate` / `type=project`）

### Google Drive / Sheets / Docs 自動取得
- メール本文中の Google Drive・Sheets・Docs の共有リンクを自動検出
- Sheets → CSV export、Docs → txt export、Drive PDF → base64化してGeminiに渡す
- 認証不要（「リンクを知っている全員が閲覧可」の共有設定前提）
- 取得失敗は無視してフォールバック

### AI プロバイダー抽象化
- **メイン**: Google Gemini 2.5 Flash Lite（Edge Function）/ Gemini 2.5 Flash（Vercel API）
- **切替**: `.env` の `AI_PROVIDER=gemini` / `AI_PROVIDER=openai` で切り替え可能
- AI解析部分は `AIProvider` インターフェースで抽象化

### 認証なし・ニックネーム制
- ログイン機能は持たない
- 初回アクセス時に「利用者のニックネーム」を入力させ、`localStorage` に保存

### データ重複管理
- **email が同じ**場合は自動で既存レコードを **UPDATE**（上書き更新）
- **AI が「名前やスキルが似ている」と判断**した場合は `duplicate_flag = true` を立てるだけ（自動マージ不可）

### AI解析ログ（ai_logs）
- 全AI解析呼び出しをDBに記録（モデル名・所要時間ms・結果JSON・エラー）
- 成功・失敗どちらもログに残す
