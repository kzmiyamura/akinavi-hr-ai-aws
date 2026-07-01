# AkiNavi HR-AI 開発フェーズ詳細

> このファイルは CLAUDE.md の参照用詳細ドキュメントです。各フェーズの実装手順・作業ログ・Issue 一覧を記録しています。

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

### 【Phase 4】Make.com 連携・UI改善・デモ環境整備 ✅（完了・メール連携は停止中）
1. **[Claude] 作業**: Make.com (Outlook) と連携した自動解析フローの実装
   - フロー: メール受信 → Make.com が検知 → Edge Function `inbound-email` → Gemini AI 解析 → DB 保存
   - 人材用メール: `akinavi.hr.ai.voice.human@outlook.jp`
   - 案件用メール: `akinavi.hr.ai.voice.project@outlook.jp`
2. **[Claude] 作業**: AI解析精度の継続的改善（プロンプトチューニング）
3. **[Claude] 作業**: Google Drive / Sheets / Docs リンクの自動取得機能実装
4. **[Claude] 作業**: デモ環境（data_env）分離・DemoSeedPanel実装
5. **[Claude] 作業**: 人材・案件の編集機能・最終更新者/日時表示
6. **[人間] 判断**: Make.com・Pipedreamともに無料枠超過 → Microsoft Graph API ポーリングへ移行決定

### 【Phase 4.5】Microsoft Graph API ポーリングへ移行 ✅（完了・稼働中）

#### 方針
Make.com・Pipedream等の外部SaaSを廃止し、**完全無料・永続稼働**のメール自動取り込みを実現する。

**新フロー:**
```
Outlook受信（5分以内）
  ↓
Supabase pg_cron（5分ごとに起動）
  ↓
Edge Function: poll-email
  - Graph APIでアクセストークン取得（リフレッシュトークンから）
  - GET /me/messages（未読メールを取得）
  - 既存の inbound-email と同じ解析ロジックへ渡す
  - 処理済みメールを既読にマーク
  ↓
Gemini AI 解析 → DB 保存
```

**コスト試算（すべて無料枠内）:**
| コンポーネント | 無料枠 | 予想消費量（5分に1回） |
|---|---|---|
| pg_cron | 制限なし | 約 8,640回/月 |
| pg_net | 制限なし | 約 8,640回/月 |
| Edge Functions | 500,000回/月 | 約 8,640回/月 |
| Microsoft Graph API | 無料 | 約 8,640回/月 |

#### 作業一覧

**【人間】手作業（Claude Codeでは実施不可）**

1. **Azureアプリ登録**（所要: 約30分）
   - https://portal.azure.com にアクセス（Microsoftアカウントでログイン・無料）
   - 「Microsoft Entra ID」→「アプリの登録」→「新規登録」
   - 名前: 任意（例: `akinavi-mail-poller`）
   - サポートされるアカウントの種類: 「個人用Microsoftアカウントのみ」を選択
   - リダイレクトURL: `http://localhost` を追加
   - 登録後、以下を控える:
     - **クライアントID（アプリケーションID）**
     - 「証明書とシークレット」→「新しいクライアントシークレット」→ **クライアントシークレット（値）**
   - 「APIのアクセス許可」→「アクセス許可の追加」→ Microsoft Graph → 委任されたアクセス許可
     - `Mail.Read` を追加
     - `Mail.ReadWrite`（既読マーク用）を追加

2. **リフレッシュトークン取得（2アカウント分）**（所要: 約30分）
   - 以下のURLをブラウザで開き、**human@outlook.jp** でログイン:
     ```
     https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize
       ?client_id=<クライアントID>
       &response_type=code
       &redirect_uri=http://localhost
       &scope=offline_access Mail.Read Mail.ReadWrite
     ```
   - ログイン後にリダイレクトされるURL（`http://localhost/?code=...`）から `code=` の値を控える
   - Claude Codeに渡してリフレッシュトークンに交換（次のClaude作業で実施）
   - **project@outlook.jp** でも同様に繰り返す

3. **Supabase Secrets に登録**（所要: 約10分）
   - Supabase Dashboard → Project Settings → Edge Functions → Secrets
   - 以下を追加:
     | シークレット名 | 値 |
     |---|---|
     | `GRAPH_CLIENT_ID` | AzureのクライアントID |
     | `GRAPH_CLIENT_SECRET` | Azureのクライアントシークレット |
     | `GRAPH_REFRESH_TOKEN_HUMAN` | human@outlook.jp のリフレッシュトークン |
     | `GRAPH_REFRESH_TOKEN_PROJECT` | project@outlook.jp のリフレッシュトークン |

4. **SupabaseでSQL実行**（所要: 約5分）
   - `supabase/migrations/add_email_polling_cron.sql` をSQL Editorで実行
   - pg_cron・pg_net の有効化とスケジュール登録

**【Claude Code】作業（完了）**

1. ✅ **Edge Function `poll-email` の実装**
   - `supabase/functions/poll-email/index.ts` を新規作成
   - 4アカウント（human/prod, project/prod, human/demo, project/demo）を `Promise.allSettled` で並列処理
   - リフレッシュトークンを `app_config` テーブルでローテーション保存（フォールバック: Secrets）
   - `resolveCallKey()`: `INBOUND_CALL_KEY` → `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_ANON_KEY` の順で `eyJ` 始まりJWTを使用
   - 処理失敗時は `markAsUnread` で元に戻し次回再試行

2. ✅ **pg_cronマイグレーションSQL作成**
   - `supabase/migrations/add_email_polling_cron.sql` を作成
   - pg_cron・pg_net の有効化、`app_config` の UNIQUE 制約追加
   - 5分ごとに `poll-email` を起動するスケジュール登録

3. ✅ **動作確認**: 4アカウント全て正常稼働（未読メール → 解析 → DB保存 → 既読マーク）

### 【Phase 4.6】Microsoft OAuth UI連携機能の追加 ✅（完了）

Supabase Secrets への手動リフレッシュトークン登録を廃止し、設定画面からワンクリックで Microsoft アカウントを連携できる OAuth フローを実装した。

#### フロー
```
設定画面で「連携する」をクリック
  ↓
Edge Function microsoft-oauth (step=start) → authorize URL 生成
  ↓
ブラウザが Microsoft ログインページへリダイレクト
  ↓
ユーザーがログイン・権限承認
  ↓
Microsoft が <origin>/auth/callback?code=...&state=<account> にリダイレクト
  ↓
AuthCallbackPage が code を受け取り Edge Function microsoft-oauth (step=callback) を呼び出す
  ↓
Edge Function が code → refresh_token を交換し app_config に保存
  ↓
成功メッセージ表示・設定ページへ誘導
```

#### 追加・変更ファイル
| ファイル | 変更内容 |
|---|---|
| `supabase/functions/microsoft-oauth/index.ts` | 新規作成：authorize URL 生成 & code 交換 Edge Function |
| `src/pages/AuthCallbackPage.tsx` | 新規作成：OAuth コールバック専用ページ |
| `src/pages/SettingsPage.tsx` | 変更：Microsoft アカウント連携セクション追加 |
| `src/App.tsx` | 変更：`/auth/callback` パスで AuthCallbackPage を表示 |
| `src/lib/db/emailSettings.ts` | 変更：`getConnectionStatuses()` 関数追加 |

#### app_config キー
| キー | 内容 |
|---|---|
| `graph_rt_human_prod` | human@outlook.jp (prod) のリフレッシュトークン |
| `graph_rt_project_prod` | project@outlook.jp (prod) のリフレッシュトークン |
| `graph_rt_human_dev` | human dev (demo) のリフレッシュトークン |
| `graph_rt_project_dev` | project dev (demo) のリフレッシュトークン |
| `graph_connected_<account>` | 連携済みフラグ（`"true"` / 未設定） |

#### Azure アプリへの追加設定（手動）
- Azure ポータル → アプリ登録 → 認証 → リダイレクト URI に `<origin>/auth/callback` を追加すること

### 【Phase 4.7】Box連携 ✅（実装完了・人間手作業待ち）

BoxはOAuth2なしで機械的なファイル取得ができないため、古いWindows PCをデータ取得専用機とした**box-downloaderバッチ**を別プロジェクトで作成し、Googleスプレッドシートをキューとして本アプリと連携する設計。

#### 全体フロー

```
① メール受信（inbound-email 改修済み）
   - メール本文中の Box URL（app.box.com/s/xxx）を検出
   - candidates.box_url に保存、box_status = 'pending' で人材を仮登録
   - Googleスプレッドシートの boxurl 列に書き込み（キュー登録）

② box-downloader バッチ（別プロジェクト・Windows PC・1日1回手動 or タスクスケジューラ）
   - スプレッドシートの「実施=空欄」行を読み込む
   - Playwright（Chromium）で Box 共有URLへアクセスしファイルをダウンロード
   - Google Drive の指定フォルダへアップロード
   - スプレッドシートの driveurl 列・実施列（成功/失敗）を更新

③ enrich-candidate バッチ（Supabase Edge Function・毎日 JST 3:00 自動実行）
   ※ box-downloader の実行（②）が完了した後に走るよう時刻設定
   - Googleスプレッドシートを読み込む（実施=成功 & driveurl あり）
   - candidates テーブルで box_url が一致 & box_status='pending' の人材を検索
   - Drive URL からファイルを取得（fetchGoogleLinks の既存ロジックを流用）
   - Gemini で再解析 → 既存レコードを UPDATE
   - box_status = 'enriched' に更新
```

#### スプレッドシート構造（box-downloaderと共有キュー）

| 列 | 名前 | 書き込み元 | 内容 |
|---|---|---|---|
| A | boxurl | inbound-email | Box共有URL |
| B | driveurl | box-downloader | Google Drive URL（アップロード後） |
| C | 実施 | box-downloader | 空欄 / 成功 / 失敗 |

#### DB変更（candidatesテーブル）

| カラム | 型 | 内容 |
|---|---|---|
| `box_url` | `text` | メールから抽出したBox共有URL |
| `box_status` | `text` | `pending`（未処理） / `enriched`（更新済み） / `failed`（失敗） |

#### 新規ファイル一覧

| ファイル | 内容 |
|---|---|
| `supabase/migrations/add_box_columns.sql` | candidates に box_url, box_status 追加 |
| `supabase/functions/enrich-candidate/index.ts` | スプレッドシート読み込み → Drive取得 → 再解析 → UPDATE |
| `supabase/migrations/add_enrich_cron.sql` | enrich-candidate を毎日 JST 3:00 に起動する pg_cron |
| `../box-downloader/` | 別プロジェクト（Node.js/TypeScript/Playwright） |

#### 改修ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `supabase/functions/inbound-email/index.ts` | Box URL 検出 → スプレッドシート書き込み + candidates.box_url 保存 |

#### 必要な Supabase Secrets

| シークレット名 | 値 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Googleサービスアカウント JSON（1行に圧縮） |
| `BOX_SPREADSHEET_ID` | キュー用スプレッドシートのID |

#### 【人間】手作業

1. **Googleサービスアカウント作成**（所要: 約20分）
   - Google Cloud Console → IAM と管理 → サービスアカウント → 新規作成
   - Google Sheets API と Google Drive API を有効化
   - キー（JSON）をダウンロード → 1行に圧縮して Supabase Secrets の `GOOGLE_SERVICE_ACCOUNT_JSON` に登録
   - box-downloader の `auth/service-account.json` にも同じJSONを設置

2. **スプレッドシート作成・共有**（所要: 約5分）
   - Googleスプレッドシートを新規作成
   - 1行目にヘッダー: `boxurl` / `driveurl` / `実施`
   - サービスアカウントのメールアドレスを「編集者」として共有
   - スプレッドシートのIDを Supabase Secrets の `BOX_SPREADSHEET_ID` に登録

3. **SupabaseでSQL実行**（所要: 約5分）
   - `supabase/migrations/add_box_columns.sql` をSQL Editorで実行
   - `supabase/migrations/add_enrich_cron.sql` の `YOUR_PROJECT_REF` と `YOUR_SERVICE_ROLE_KEY` を書き換えてから実行

4. **box-downloaderのセットアップ**（所要: 約15分）
   - `setup.bat` を実行して依存パッケージをインストール
   - `setup-drive-auth.bat` を実行してGoogleドライブOAuth2認証を完了
   - `config.json` にスプレッドシートURL・ドライブフォルダIDを設定
   - `run.bat` で動作確認

### 【Phase 4.8】skill_master スキルマスター ✅（実装完了・人間手作業待ち）

#### 概要
`skill_master` テーブルにITスキルを蓄積し、`inbound-email` Edge Function で AI を使わずにスキルを照合・抽出する。AI が新スキルを発見した際は自動的に DB に登録し、毎日クリーンアップ Cron でゴミエントリを除去する。

#### フロー（コミット `139a4f2` で AI 完全廃止後の現行）

```
① inbound-email でメール受信
   ↓
② URL ストリッピング + 送信者署名除去（コミット `ccc82ec`）
   - "https://...cc.php" 等が PHP/HTTPS に誤マッチするのを防止
   - "〒XXX-XXXX 東京都..." 等の署名行を都道府県判定から除外
   ↓
③ skill_master DB照合（AIなし）
   - 本文と添付を別ロジックで照合（本文: certContext 内のみ資格判定 / 添付: 全文 fallback）
   - スキルシート形式の場合は A/B/C 評価のみ採用、D/E は除外
   - 添付は上位 20 件に絞る（スキルシート一覧の過剰ヒット防止）
   - フェーズ表ヘッダー行（"調査分析 要件定義 ..."）は役割・業界の判定から除外
   ↓
④ regex / 文章スキャンで残りフィールドを抽出（AIなし）
   - 氏名・最寄駅・都道府県・経験年数・希望単価・参画時期・希望案件
   - 駅 → 都道府県マッピングで送信者署名由来の誤判定を上書き
   ↓
⑤ DB照合スキルを candidates.skills と candidate_skills に保存
   - match_count を RPC でインクリメント（fire and forget）
   ↓
⑥ 毎日 JST 3:00 に skill-master-cleanup が実行
   - ルールベースでゴミエントリ（source='ai'）を削除
   - 30日間未マッチ（match_count=0）のエントリを削除
```

※ ③ で `skill_master` に **未登録の業界標準スキル**（JP1/Teraterm/Zabbix/Hinemos/Tivoli/HULFT/上級情報処理士/ITパスポート ほか）はコミット `acf9d31` で 32 件追加済み（`supabase/migrations/20260520121447_fix_skill_master_quality.sql`）。AI が新スキルを自動登録する経路は inbound-email の AI 廃止により**現状動いていない**点に注意。

#### 新規ファイル一覧

| ファイル | 内容 |
|---|---|
| `supabase/migrations/add_skill_master.sql` | skill_master テーブル作成 + increment_skill_match_counts RPC |
| `supabase/migrations/seed_skill_master.sql` | ~1600件のシードデータ |
| `supabase/functions/skill-master-cleanup/index.ts` | 毎日クリーンアップ Edge Function（AIなし・ルールベース） |
| `supabase/migrations/add_skill_cleanup_cron.sql` | クリーンアップ pg_cron スケジュール |
| `scripts/skill_master_review.py` | **月次レビュースクリプト**（Claude Code が毎月実行） |

#### 品質チェック（Claude Code が定期実行すること）

「品質チェックして」または `/quality-check` で実行。詳細手順は `.claude/commands/quality-check.md` を参照。

概要:
1. **skill_master メンテ** — 不要エントリ削除・未登録スキルの追加
2. **駅名マッピング** — `[station_unmapped]` ログ確認・頻出駅を追記
3. **取りこぼし調査** — 名前不明・null項目・誤登録の原因調査 → 確認後に修正・デプロイ
4. **異常監視** — ai_logs のエラー率・処理時間を確認
5. **AIコスト監視** — Gemini 無料枠・フォールバック多発・重複スコアリングを確認
6. **年齢・性別取得率** — 50% 未満なら本文パターンを調査して regex 追加
7. **フィールド充足率** — selfPR / agentComment / nationality の取得率確認
8. **名前汚染チェック** — 性別・年齢・記号が名前に混入していないか確認
9. **非人材メール混入チェック** — 業務メールが人材として登録されていないか確認
10. **複数人メール分割失敗チェック** — 1通に複数人が混入していないか確認
11. **skillYears 取得率チェック** — Excel スキルシートから経験年数が取れているか確認（drive_url あり候補者で低率なら `extractSkillYearsFromSheetData` を調査）
12. **抽出ロジック回帰テスト** — `node scripts/test_extraction.mjs --test` で全件パスを確認

#### 【人間】手作業

1. **SupabaseでSQL実行**（所要: 約5分）
   - `supabase/migrations/add_skill_master.sql` を SQL Editor で実行
   - `supabase/migrations/seed_skill_master.sql` を SQL Editor で実行
   - `supabase/migrations/add_skill_cleanup_cron.sql` の `YOUR_PROJECT_REF` と `YOUR_SERVICE_ROLE_KEY` を書き換えてから実行

### 【Phase 4.9】inbound-email から AI 解析を完全除去（コミット `139a4f2` で完了 + `a4dc3b4` でデッドコードも削除）

#### 背景・成果
- 無料枠の Groq `llama-3.1-8b-instant` が 1 日 125 件で枯渇し無限リトライループに陥っていた
- 名前抽出など regex / 文章スキャン側のフォールバックロジックが十分に成熟していたため AI を排除する判断
- メール取り込みが**完全無料・上限なし**で永続稼働するようになった

#### 現行の抽出パイプライン（AI 不使用）
| ステップ | 関数 | 内容 |
|---|---|---|
| 0 | `TRAINING_REPORT` / `PROJECT_SOLICITATION` フィルタ | 「研修内容について報告します」「案件情報のご紹介でございます」等のキーワードを含む人材メールを即スキップ（コミット `1631a32`・人材メールボックスへの誤投函対策） |
| 1 | `decodeHtmlEntities` | `&amp;` 等の HTML エンティティを実体に戻す |
| 2 | `stripUrlsForSkillMatching` | URL を除去（`https://.../cc.php` 等が PHP/HTTPS に誤マッチするのを防止） |
| 3 | `stripSenderSignature` | 「━━━」「───」等の長い区切り線以降を送信者署名とみなして除去 |
| 4 | `extractAndRemoveSkills` | `skill_master` で本文・添付を別ロジックで照合。スペースなし比較（`Spring Boot` ↔ `Springboot`）に対応 |
| 5 | `filterBySkillRating` | スキルシートの A〜E 評価で D/E 評価のスキルを除外 |
| 6 | `extractCandidateFieldsRegex` + `flexLabel` | 氏名・最寄駅・都道府県・経験年数・希望単価・参画時期・希望案件を 2 段階 regex で抽出。`flexLabel` でラベル文字間の全角/半角スペースを許容（`単　価` / `氏　名` 等）、`SEP` に `】` を含めて `【単　価】65万` のような囲み記号にも対応 |
| 7 | `inferPrefectureFromStation` | 駅名から都道府県を逆引きして送信者住所由来の誤判定を上書き。約 254 駅・32 都道府県をカバー（後述）。マップ未収載の駅は `console.log('[station_unmapped]', ...)` でログ出力 |
| 8 | `isPhaseTableHeader` + `extractFromProse` | フェーズ表ヘッダー行を除外した上で `PROSE_ROLES` / `PROSE_INDUSTRIES` を文章スキャン |
| 9 | `splitMultiCandidateBody` | 区切り線（`*****` / `─────`）で 1 メール=複数候補者を分割（区切り線 2 本以上を条件・コミット `baac676` で強化） |
| 10 | `extractAgentComment` | エージェント所感・推薦コメント・備考等を最大 500 字で抽出して `raw_profile.agentComment` に保存 |
| 11 | 重複判定（ルールベース） | 名前完全一致 + スキル Jaccard ≥ 0.4 → `duplicate_flag=true`。駅違いは別人とみなす（コミット `0998d49`） |
| 12 | 自動マッチ（任意） | `AUTO_MATCH_ENABLED='true'` のとき `matchCandidateToProject` 経由で即時スコア計算（唯一の inbound-email 内 AI 呼び出し） |

#### 削除済みのデッドコード（コミット `a4dc3b4` で全廃）
- `classifyInboundRelevance`（STEP1 関連性チェック）
- `generateJSONSmart`, `generateJSONWithCerebras`, `generateJSONWithGroq`, `generateJSON`（`kind='candidate'/'project'`）
- `buildCandidateGroqPrompt` / `buildProjectGroqPrompt`
- `inbound-email` 用の Gemini プロンプトビルダー全般

→ Grep で `supabase/functions/` 全体で 0 ヒット確認済み。残るのは `matchCandidateToProject` 内の `generateJSON kind='match'` のみ。

#### 案件メールの解析（コミット `c8be840` で人材と同じ regex 基盤に統一）

##### フィールド抽出（`extractFieldTwoPhase` を案件にも適用）
| フィールド | ラベル | ISO 変換 | 特記 |
|---|---|---|---|
| 場所 | `場所/勤務地/就業場所/作業場所/常駐先/Working Location` | — | 駅名のみなら `inferPrefectureFromStation` で都道府県付与・未解決は `[station_unmapped]` ログ |
| 単価 | `50〜80万`/`60万`/`単金` 系 | — | `WS = '[ \\t\\u3000]*'` で全角スペース対応 |
| 時期 | `参画時期/開始時期/開始日/期間/稼働開始/契約期間/Period` 等 | `7月〜2027年2月` 等の範囲を ISO 化 | コミット `c779a6c` で実装 |
| 備考 | `備考/補足` | — | コミット `2c73a40` で `【内容】` セクションが既にある場合も**常に追記** |
| 募集人数 / 契約形態 / クライアント / 商流 / 精算幅 / 面談形式 | 各種 | — | すべて `extractFieldTwoPhase` 経由 |

##### ブラケット・デコレータ正規化
- `【場所】【単価】【時期】【備考】` ブラケット形式（コミット `2a43bf5`）：`SEP` 正規表現に `】` を含めることで囲みラベル直後の値を抽出
- `◆氏名◆` のようなデコレータ（コミット `932ce3a`）：`DECO_RE` で削ってから `flexLabel` に渡す

##### スキル抽出の堅牢化
- `PROJECT_PROCESS_NOISE = ['システム開発', '機能追加', '改修']`（コミット `7d7ff91` で**縮小**。以前は工程語を多数除外していたが、`skill_master` に `テスト/保守開発/保守運用/調査分析` 等を追加して**残す方針**に転換）
- `【スキル】〜次の【...】` セクション内に絞り込んで照合（コミット `95ef77e`）
- `<尚可>` セクション分離で必須スキル / 歓迎スキルを別格納
- `SKILL_NOISE_WORDS`（必須・歓迎・尚可・優遇・経験・実務・業務・対応・作業・設計・開発 等 23 語）で汎用語を除外

#### 駅 → 都道府県マッピング（コミット `2e9b559` / `d7157b7` で大幅拡充）
- **約 254 駅・32 都道府県をカバー**（千葉 28・埼玉 19・神奈川 24・東京 42・茨城 6・大阪 29・京都 11・兵庫 15・愛知 17・福岡 17 ほか）
- 案件側にも適用（`d7157b7`）：勤務地が駅名のみの場合に都道府県を推定
- **同名駅の衝突（既知の改善余地）**：`町田`（神奈川/東京）・`野田`（千葉/大阪）・`福島`（大阪/福島）は後勝ちで上書きされる。配列値化やキー接尾辞化が将来課題
- **未解決駅の運用**：`console.log('[station_unmapped]', station)` で Supabase Logs に蓄積 → `.claude/skills/quality-check/SKILL.md` の手順で月次レビュー → `STATION_TO_PREFECTURE` に追記 → `npm run deploy:edge`

### 【Phase 4.10】マッチングの全面再設計（コミット `b35df40` で完了）

#### 背景・成果
- AI 呼び出しが 1 ペアごとに発生していたため、案件 × 候補者 = 数百〜数千ペアで Groq / Gemini を消費しすぎていた
- 「ルールベース事前フィルタ + バッチ AI 採点」方式に転換し、**1 案件 = 1 AI コール**まで圧縮
- AI が全段失敗してもルールスコアで全代替できるため、無料枠超過時も処理は継続

#### 新 Edge Function `match-batch`（`supabase/functions/match-batch/index.ts`）

##### モード
- `project_to_candidates`：1 案件 × 多人材を一括採点
- `candidate_to_projects`：1 人材 × 多案件をコメントのみ生成（score は AI に出させない設計）

##### ルールベーススコア `calcRuleScore`（0〜100pt）
| 観点 | 配点 | ロジック |
|---|---|---|
| スキル一致 | 最大 40pt | `required_skills` がある場合のみ算出。完全一致 1pt / includes 部分一致 0.5pt → `(hits/required.length) * 40`。required 空のときは固定 +20 |
| 経験年数 | 最大 15pt | 10年=15 / 7年=12 / 5年=8 / 3年=4 / 1年=2 |
| 単価 | 最大 15pt | `budgetMax==null` なら +15 固定、範囲内 +15、上限+10% +8、上限+20% +3 |
| 勤務地 | 最大 20pt | 同じ都道府県（接尾辞除去 includes 一致） +20、フルリモート（`/フルリモート\|完全リモート\|100[%％]リモート/`） +20、居住地不明 +5 |
| リモート | 最大 10pt | `!isFullRemote && remoteAvailable && /リモート\|remote\|在宅/i.test(remotePolicy)` で +10 |

##### バッチ AI プロンプト
- 1 コールで topN 名（既定 10）を一括採点
- 各候補者に `ruleScore` を埋め込み、**「ruleScore を参考にしつつ役割・経歴・希望職種で再採点」**を AI に指示
- `summary` は **150 字以内**で「必須スキル合致 → 経験年数 → 単価 → 勤務地リモート → 懸念点」の優先順
- 出力形式: `[{"id":"...","score":整数,"summary":"150字以内"},...]`

##### AI フォールバック順
Cerebras `llama3.1-8b`（タイムアウト 20s）→ Groq `llama-3.3-70b-versatile`（25s）→ Gemini `gemini-2.5-flash`（30s）

##### 失敗時挙動
3 段すべて失敗時は `usedModel='rule'` を返し、ルールスコアで全代替。`results` には topN、`ruleOnly` には残り（AI summary 空）が入る。

#### `match-score`（既存・UI 手動・単発スコア）
- 1 ペアの詳細スコア + `duplicateSuspected` フラグ（同名同スキル候補の重複疑い検出）
- マッチング理由 **150 字**（コミット `0d1af7e` で 100 字 → 150 字）
- AI フォールバック順は `match-batch` と同じ
- 居住地・希望勤務地・案件備考・本人希望のスコア反映は **`match-batch` の `calcRuleScore` に集約**（`match-score` 側は AI へ丸投げ）

#### `auto-match`（毎朝 JST 9:00 cron・コミット `aa480b8` 以降全面書き直し）
- `app_config.auto_match_enabled='false'` でスキップ（既定 true）
- 対象: `data_env='prod'` で `created_at >= NOW() - 25h` の案件
- 既存 `submissions` ペアと `accepted` 状態の人材を除外
- **JS 側スキル重複フィルタ**（jsonb skills 列に `&&` が使えないため includes でゆるい一致）
- `MAX_CANDIDATES_PER_PROJECT=40` / `BATCH_AI_SIZE=20`（20 名 × 2 リクエストで 40 名カバー）
- `match-batch` を `Promise.allSettled` で叩いて submissions upsert（`onConflict: 'candidate_id,project_id'`、`ai_raw: { autoMatched: true, source: 'auto-match-cron' }`）

#### `MatchingPage`（コミット群: `1bf49ff`, `51f966d`, `aa480b8`, `c6ced01` 等）
- **`duplicate_flag=true` と `merged_into != null` の人材をマッチング対象から完全除外**
- 候補者取得を **RPC 化**：`fetch_candidates_for_matching(p_data_env, p_limit DEFAULT 800)` で `created_at DESC, COALESCE(experience_years, 0) DESC` 順
- 案件→人材は **SQL 側スキル絞り込み**：`fetch_candidates_for_project(p_data_env, p_skills text[], p_limit DEFAULT 500)` で `jsonb_array_elements_text` 展開後マッチ
- マッチング詳細パネルに案件サマリー（必須スキル上位 10 件、予算、勤務地、リモート、開始日、roleSummary / description 先頭 150 字）
- bulk マッチング進捗表示（`MatchRunProgress`）とキャンセル機構（`bulkCancelRequestedRef`）
- 全 mutation の `onError` で `logError(e, 'MatchingPage', undefined, { dataEnv, nickname })` を呼び `error_logs` に保存

### 【Phase 4.11】UI 統一とデモ生成のルールベース化（コミット群: `f28ec86` / `04f0e98` / `3ec217b` / `060f0d7` / `adc6f3a` ほか）

#### CandidatePage / ProjectPage
- 「AI で登録」ボタンを廃止し**「登録」ボタンに一本化**（`f28ec86`）
- 登録ボタンは `inbound-email` を `force=true` で叩く（DEDUP / SENDER_DAILY_LIMIT / inbound_project_enabled ゲートをバイパス）
- **AI なしで登録モード**（`04f0e98`）: メール取り込みと同じ regex + skill_master 方式を直接適用
- **「再解析」ボタン**（`7a9bb10`）: `raw_profile.text` を本文として `inbound-email` に再投入（新規 INSERT として）
- **検索スコープ選択 tags / body / all**（`c5bfd41`）: `search_candidates(p_scope)` の 3 モード
- **スキル本人強調度順ソート**（`1c04c4c`）: 出現回数 + 「希望/得意/専門/強み/メイン」等の近傍 ±30 字 +2 + 前半 500 字内 +1
- **返信ボタンに元メール本文引用**（`c915e76`）: `mailto:` の body に元差出人・件名・受信日時・本文先頭 800 字
- **データ再読み込みボタン**（`7f4c8ed`）: TanStack Query を invalidate
- **エージェントコメント表示**（`bcd0fdb`）: `raw_profile.agentComment` を黄色枠で `whitespace-pre-wrap`
- **年齢・性別表示**: `経験X年 ／ X歳（男性/女性）`
- **画像アップロードは現状エラー表示**（コード残るが UI から呼ばれない）

#### デモ生成（AI 不使用・ルールベース化）
- `DemoSeedPanel`（`3ec217b` で AI 完全除去）: 1 ペア（人材+案件）のテンプレ生成・本番→デモコピー（random/recent モード）・デモメール再解析
- `DemoProjectCandidateGen`（`060f0d7`）: 選択中案件ベースのスコア別 5 人生成（90/70/50/30/10pt 想定）
- リアルなエージェントメール本文生成（`0e963d9`）: `inbound-email` regex で確実に拾えるフォーマット
- 表示条件は `demoUiEnabled === true` のみ（dataEnv 不問・コミット `95120c1`）
- 本番→デモコピー（`copyProdCandidatesToDemo`）: `email` を `demo.prod+<uuid>@demo.invalid` に差し替え、`resume_url` / `box_url` を落として保存

### 【Phase 4.12】人材マップ（ヒートマップ）と 7 日アーカイブ機構（コミット群: 2026-05-23）

#### 背景
- 「どの都道府県に何人いるか」を視覚的に把握したいという営業要望
- 単純集計だと過去データ（7 日で削除される人材）が見えないため、アーカイブ機構を併設

#### 新規ファイル
| ファイル | 内容 |
|---|---|
| `src/pages/HeatmapPage.tsx` | 5 タブ目「人材マップ」。`d3-geo`（Mercator） + 生 SVG `<path>` + `topojson-client` で日本地図描画 |
| `src/lib/db/heatmap.ts` | RPC ラッパ（`fetchPrefectureCounts` / `fetchCandidatesByPrefecture` / `fetchSkillNames`） |
| `public/japan.topojson` | 47 都道府県の TopoJSON（約 416 KB・`properties.nam_ja` 使用） |
| `supabase/functions/archive-candidates/index.ts` | 7 日経過した prod 人材を `candidates_archive_light` にサマリー化してから DB 削除 |
| `supabase/migrations/20260523_prefecture_counts_rpc.sql` | 初版 RPC |
| `supabase/migrations/20260523_archive_light_table.sql` | `candidates_archive_light` テーブル + 期間対応版 RPC |
| `supabase/migrations/20260523_normalize_prefecture.sql` | `normalize_prefecture` 関数 + 最終版 RPC `prefecture_counts` / `candidates_by_prefecture` |
| `supabase/migrations/add_archive_candidates_cron.sql` | 旧 `delete-old-candidates` を unschedule → 新 `archive-candidates-daily`（毎日 JST 0:00）を schedule |

#### 改修ファイル
- `src/components/Layout.tsx` / `src/App.tsx`: 5 タブ目「人材マップ」追加（`Map` アイコン）
- `package.json`: `d3-geo` / `topojson-client` / `topojson-specification` / `@types/topojson-client` / `react-simple-maps` / `@types/topojson-client` を追加

#### 主要機能
- **期間トグル**: 「直近 7 日」（既定）= `candidates` のみ / 「全期間」= `candidates_archive_light` も合算
- **スキルフィルター**: `skill_master` から `match_count` 降順 200 件をオートコンプリート → `cs.skill ILIKE '%skill%'` で部分一致
- **塗り色**: `sqrt(count/max)` ベースの薄青〜濃青グラデーション。選択中はオレンジ
- **詳細パネル**: 都道府県クリックで `candidates_by_prefecture` RPC を呼び、最大 10 件を `created_at DESC` で表示（`merged_into IS NULL` かつ `duplicate_flag = false`）。アーカイブ済みは「アーカイブ」バッジ
- **キャッシュ**: TanStack Query の `staleTime` で 60s / 5min / 30s

#### `normalize_prefecture` 関数
表記ゆれを吸収して都道府県名を正規化:
- `'日本'` / `'関東'` / `'全国'` / `'リモート'` / 英字含む → NULL
- `'東京都 大森'` → `'東京都'`（regex で切り出し）
- `'茨城'` → `'茨城県'`（39 県分の固定リストで接尾辞補完）
- `'東京'` → `'東京都'`、`'大阪'` → `'大阪府'`、`'京都'` → `'京都府'`、`'北海'` → `'北海道'`

#### 既知の migration 漏れ
`20260523_archive_light_table.sql` は `name` / `subject` カラムを定義していないが、`archive-candidates` Edge Function と `candidates_by_prefecture` RPC が両カラムを参照する。新規環境では以下の手動 ALTER が必要:

```sql
ALTER TABLE candidates_archive_light
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS subject text;
```

詳細は `docs/Heatmap.md` を参照。

#### Storage 書き込みの廃止
コミット `71d6aea`（2026-05-23）で `archive-candidates` の Storage 書き込みは廃止。現在は `candidates_archive_light` のみ書く設計（容量削減・運用簡素化）。長期保存が必要な場合は別途 JSONL バックアップを検討すること。

### 【Phase 4.13】マッチングロジックの SQL 化・ウェイト可変化・地方加点（コミット群: 2026-05-25 〜 2026-05-27）

#### 背景
- マッチング処理のタイムアウト・ハルシネーション・配点固定の限界を解消
- 「東京都 大森」に「京都」が部分一致するなどの実バグ修正
- 営業から「スキルウェイトを案件ごとに調整したい」要望

#### マイグレーション群（順に実行）
| ファイル | 内容 |
|---|---|
| `20260525_fix_matching_rpc_duplicate_filter.sql` | `duplicate_flag=true` を SQL 側で除外。`fetch_candidates_for_matching` 上限 800→2000 へ |
| `20260525_fetch_candidates_with_rule_score.sql` | `fetch_candidates_for_project` をルールスコア順に再定義（旧版を DROP） |
| `20260526_fetch_candidates_with_weights.sql` | スキル/経験/単価/勤務地/リモート の 5 ウェイトを引数化（`p_weight_skill` ほか） |
| `20260526_fix_timeout.sql` | CROSS JOIN LATERAL でルールスコアを 1 回だけ計算（`statement_timeout=30000ms`） |
| `20260526_region_location_scoring.sql` | `get_region(prefecture_core)` 関数を追加。**同一都道府県 20pt / 同一地方 10pt / 居住地不明 5pt / 不一致 0pt** |
| `20260527_fix_kyoto_bug.sql` | LIKE 部分一致から完全一致判定へ変更（東京都 ⊂ 京都府 の誤マッチを修正） |

#### `match-batch` 側の主要変更
- `topN` は **既定 10 件**（コミット `0626e82`）。残りはルールスコアのみで `ruleOnly` 配列として返却
- **スキル全不一致時の上限 35pt**（コミット `eb03686 #12`）: `required.length > 0 && hits === 0` なら合計 35pt キャップ
- **歓迎スキル一致 +0.1 ボーナス**（コミット `c6b4342`・最大 40pt キャップ）
- **経験年数不明 → 5/15pt（中間点）**（コミット `0507697`）。以前は 0pt
- **AI スコアは変更禁止**（コミット `c62bac2` 以降）: 旧 `±15pt` クリップから、AI に「`score をそのまま使うこと（変更禁止）`」と指示する方針へ変更。AI は summary 生成だけを担当
- **フルリモート希望 × 常駐案件は 30pt 上限**（コミット `637152f`）: `raw_profile.wantsFullRemote=true` かつ案件側に `リモート/remote/在宅/フルリモート` 記述がない場合キャップ。`breakdown` 末尾に `[フルリモート希望・常駐案件のため30pt上限]` 注記
- **AI コメント** に breakdown / リモート可否 / 人物像 / 本人希望 / 国籍懸念を必須化（コミット `b1569ef` / `c5b97a6` / `c78ee9c`）
- **Excel `skillYears` 活用**（コミット `5f61959`・必須スキルの実年数を反映）
- **必須スキルへの「希望」表明で経験 5年相当(8/15)**（コミット `24ebe7d`）
- max_tokens: Cerebras 4096 / Groq 8000 / Gemini 8000（コミット `522825f`・20 人分 JSON 切断対策）
- Cerebras はプロンプト 22500 文字超でスキップ（`f501268`）
- スコアウェイトのカスタム UI（コミット `4b04086`・`MATCHING_DEFAULTS`）

#### `match-batch` の AI プロンプト最適化
- `filterRelevantSkills` で必須/歓迎スキルにマッチするものを優先し最大 10 件に絞る
- ruleBreakdown を**そのままプロンプトに渡し**、AI には事実記述のみさせる
- 「スコア数値・分数禁止」「リモート不可等の推測禁止」を明示
- nationality / wantedJobs / selfPR / agentNote を非日本語・指定値時のみ含める

### 【Phase 4.14】Issue 連携・station_master DB 化・抽出精度改善（コミット群: 2026-05-27 〜 2026-05-28）

#### 概要
- 営業からの改善案・バグ報告を GitHub Issue に直結する仕組みを導入
- 全国 1,797 駅のマッピングをハードコードから DB テーブルに移行（運用時の追加を簡素化）
- 経歴書フォーマットの揺れに対応する抽出ロジック改善（Issue #19〜#25）

#### 新規ファイル
| ファイル | 内容 |
|---|---|
| `supabase/functions/create-github-issue/index.ts` | GitHub Issues API ラッパ Edge Function（POST 作成 / GET 一覧 / PATCH クローズ）。`GITHUB_TOKEN` 必須。`REPO` は `kzmiyamura/akinavi-hr-ai-aws` 固定 |
| `supabase/migrations/20260527_add_station_master.sql` | `station_master` テーブル（id / name / prefecture）+ 全国 1,797 駅の INSERT。RLS 読み取り全許可 |

#### 改修ファイル
- `supabase/functions/inbound-email/index.ts`: 起動時に `station_master` をロードして `STATION_TO_PREFECTURE` とマージしてキャッシュ（`_stationDbMap`）。`preloadStationMap()` をリクエスト処理の冒頭で呼ぶ
- `src/pages/SettingsPage.tsx`: 「改善案・バグメモ」セクション + 一覧（ページネーション付き）+ Issue クローズボタン
- `src/components/Layout.tsx`: **タブを 4 つに集約**（`マッチング` / `人材` / `案件` / `設定`）。「人材マップ」は**「人材」タブ内のサブ画面**として `CandidatePage` から `onOpenHeatmap` で遷移
- `src/pages/CandidatePage.tsx`: 「人材マップ」ボタン追加（`MapIcon`）
- `src/pages/MatchingPage.tsx`: マッチング実行モード（高速/全件）の設定を SettingsPage に移動（Issue #1）

#### Issue ベースの改善（#1〜#25・27 コミット）
- **#1**: マッチング実行モードを SettingsPage に移動
- **#2/3/4**: タブ名短縮（「マッチング結果」→「マッチング」など）・「人材マップ」を「人材」タブ内へ移動・デモトグルを設定画面に集約
- **#5/6/8**: 案件未反映バグ修正・誤認識フィルター・Issue 登録後にメモ欄を空に
- **#7**: 全国 1,797 駅の `station_master` テーブルを追加・DB 参照に対応
- **#9/10/11**: Issue 一覧のページネーション・経験年数抽出改善・人材マップのクラッシュ修正
- **#12**: スキル全不一致時の上限 35pt 制限
- **#13**: CLAUDE.md に Issue 自律ループを追加
- **#14**: 楽観的更新で Issue リスト即時反映
- **#15**: イニシャルのみパターンの名前抽出
- **#16**: 複数人材メールで同じ名前が連続登録される問題を修正
- **#17**: 案件メールが人材として登録される問題を修正（営業/広告メールフィルター強化）
- **#18**: 自己 PR に送信者署名（株式会社名等）が混入する問題を修正
- **#19**: 単価の取り込み精度向上（範囲・ラベルなし・月額ラベル対応）
- **#20**: Issue 登録後に一瞬表示されて消える問題（refetch を 3 秒遅延）
- **#21**: 名前に年齢・性別が混入（男性：51 歳）パターンに対応
- **#22**: 年齢・性別が表示されない問題（#21 修正で raw_profile に正しく保存）
- **#23**: バングラデシュ籍の国籍抽出
- **#24**: `[氏名]OY` の名前から `[ラベル]` プレフィクス除去
- **#25**: HTML テーブル形式メールで情報が取れない問題を改善
- **#32**: マッチング結果で案件の必須スキルを先頭に表示・緑色ハイライト
- **#33**: 全角イコール区切り線の複数人分割に対応
- **名前汚染パターン除去・スキップキーワード追加**（コミット `51c1c9a`）
- **区切り線誤分割・案件誤認・経歴書リンク不具合の修正**（コミット `ae626ae`）
- **フルリモート希望人材を常駐案件で 30pt 上限に**（コミット `637152f`）

#### `create-github-issue` Edge Function の使い方
- **POST**: `{ memo, url, userAgent, nickname, timestamp }` → `[Bug] <先頭50字>` のタイトルで Issue 作成（`labels: ['bug']`）
- **GET**: open + closed の bug ラベル付き Issue を `created` 降順で 20 件返す
- **PATCH**: `{ number, state }` で Issue クローズ／再オープン
- CORS は全許可。`GITHUB_TOKEN` 未設定時は 500 エラー

### 【Phase 5】最終納品ドキュメント作成（一部進行中）
1. **[Claude] 作業**: システム構成図のメンテナンス（README.md に Mermaid 図あり・コミット `2026-05-20` で更新）
2. **[Claude] 作業**: 操作マニュアルのメンテナンス（`docs/Sales_Manual.md` / `docs/Sales_Manual.pdf`・営業担当者向け）
3. **[Claude] 完了**: 全成果物を commit & push し、納品完了
