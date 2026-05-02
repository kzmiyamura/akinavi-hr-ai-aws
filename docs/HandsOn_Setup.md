# AkiNavi HR-AI 環境構築ハンズオン

新規メンバーまたは新しい Supabase プロジェクトで、**フロント・DB・Edge Functions・メール自動取り込み**まで一通り再現するための手順書です。  
前提知識は「Git とターミナルが触れる」「ブラウザで Supabase / Vercel の画面を操作できる」程度を想定しています。

---

## この資料のゴール

- ローカルで `npm run dev` が動き、Supabase の **本番相当の DB** に接続できる。
- SQL を適用し、`candidates` / `projects` 等のテーブルと RLS が揃っている。
- Edge Function `inbound-email` / `poll-email` がデプロイされ、Secrets が揃っている。
- （任意）Vercel にフロントを載せ、本番 URL から同じ Supabase を参照できる。
- （任意）Outlook + Microsoft Graph のリフレッシュトークンと pg_cron で、**メール自動取り込み**が回る。

**目安時間**: 初回 3〜6 時間（Azure AD / Graph の初回設定を含むと上限側）。

---

## 第0章 全体像と用意するもの

### アーキテクチャ（要点）

- **フロント**: React（Vite）→ ブラウザから Gemini で解析することも、Supabase に直接 read/write することもある。
- **DB / API**: Supabase（PostgreSQL + Edge Functions）。
- **メール（本リポジトリの標準経路）**: **pg_cron** が 5 分ごとに **`poll-email`** を叩く → **Microsoft Graph** で Outlook 未読取得 → 各メールを **`inbound-email`** に渡して Gemini 解析 → DB 保存。  
  `inbound-email` は **Make.com 等の Webhook から直接 POST する経路**にも対応している（ペイロード仕様は Edge ソース先頭コメント参照）。

### アカウント・キー（チェックリスト）

| 項目 | 用途 |
|------|------|
| GitHub アクセス | リポジトリの clone |
| Supabase プロジェクト | DB・Edge・Secrets |
| Google AI（Gemini）API キー | ブラウザ解析・Edge `inbound-email` |
| （メール自動）Microsoft アカウント（Outlook）× 本番/デモの数 | Graph ポーリング |
| （メール自動）Azure AD アプリ登録 | `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` |
| （フロント本番）Vercel | ホスティング・`VITE_*` 環境変数 |

### コストの目安

- Supabase / Vercel は無料枠内に収まる構成を想定しているが、**利用量とプランは各自で Dashboard を確認**すること。
- Gemini は無料枠・従量課金のどちらもあり得る。

---

## 第1章 リポジトリとローカルフロント

### 1.1 前提

- **Node.js 20 以上**、npm 9 以上（`README.md` 準拠）。
- **Git**。
- Edge をデプロイする場合は **Supabase CLI**（例: `brew install supabase/tap/supabase`）。

### 1.2 Clone と依存関係

```bash
git clone https://github.com/kzmiyamura/akinavi-hr-ai.git
cd akinavi-hr-ai
npm install
```

### 1.3 環境変数（フロント）

```bash
cp .env.example .env.local
```

`.env.local` を編集する。**実際のプロジェクト URL / anon key は自分の Supabase から取得**する。

| 変数 | 説明 |
|------|------|
| `VITE_SUPABASE_URL` | Supabase プロジェクト URL |
| `VITE_SUPABASE_ANON_KEY` | anon（公開）キー |
| `VITE_AI_PROVIDER` | 通常は `gemini` |
| `VITE_GEMINI_API_KEY` | ブラウザから呼ぶ Gemini 用 |
| `VITE_GEMINI_MODEL` | 任意。未指定時は既定モデル（README 参照） |
| `VITE_DEMO_KEY` | 任意。`?demo=` でデモ環境表示切替（README「データ環境」参照） |

`.env.example` にある `GEMINI_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 等は **Vercel のサーバーレスやローカルバックエンド用**の名残であり、**通常の `npm run dev` だけなら必須ではない**場合が多い。迷ったら `README.md` の「ローカル開発環境の構築手順」に合わせる。

### 1.4 起動とビルド確認

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開き、エラーなく表示されることを確認。

```bash
npm run build
```

TypeScript と Vite ビルドが通ることを確認。

### 1.5 テスト（任意だが推奨）

```bash
npm run test:run
```

---

## 第2章 Supabase データベース

### 2.1 新規プロジェクト

1. Supabase でプロジェクト作成。
2. **Project Settings → API** で `URL`・`anon`・`service_role` を控える（`service_role` は**絶対にフロントに埋め込まない**）。

### 2.2 ベーススキーマ

SQL Editor で **`supabase/schema.sql`** を実行する（テーブル・RLS の土台）。

### 2.3 マイグレーション（ファイル名の辞書順）

`README.md` では `supabase/migrations/` を**ファイル名順**に実行するとある。本リポジトリでは次の並びになる。

1. `add_ai_logs.sql`
2. `add_candidate_skills.sql`（**14 カテゴリの CHECK 制約はこのマイグレーションを正**とする。`CLAUDE.md` 参照）
3. `add_data_env.sql`
4. `add_email_polling_cron.sql` → **第3章の後半**で中身を書き換えてから実行推奨（`YOUR_PROJECT_REF` / `YOUR_SERVICE_ROLE_KEY`）
5. `add_project_detail_fields.sql`
6. `add_projects_updated_by.sql`
7. `add_updated_by.sql`

各ファイルを**そのまま全文**コピーして SQL Editor で実行すればよい。エラーが出た場合は、同じマイグレーションを二重実行していないか、`schema.sql` が先に成功しているかを確認する。

### 2.4 拡張（メールポーリングを使う場合）

`add_email_polling_cron.sql` 実行前に、Dashboard → **Database → Extensions** で **`pg_cron`** と **`pg_net`** を有効にする（ファイル内コメントにも記載あり）。

---

## 第3章 Edge Functions

### 3.1 CLI でログイン・リンク

```bash
cd /path/to/akinavi-hr-ai
npx supabase login
npx supabase link --project-ref <YOUR_PROJECT_REF>
```

### 3.2 デプロイ

```bash
npx supabase functions deploy inbound-email
npx supabase functions deploy poll-email
```

### 3.3 Secrets（Dashboard → Edge Functions → Secrets）

**`inbound-email` で必須（コード上 `getEnv` で読むもの）**

| Secret | 説明 |
|--------|------|
| `GEMINI_API_KEY` | Gemini（サーバー側解析） |
| `SUPABASE_URL` | 通常は CLI / ダッシュボードが自動設定 |
| `SUPABASE_SERVICE_ROLE_KEY` | DB 書き込み用（**漏洩厳禁**） |

**任意（`inbound-email` 先頭コメント参照）**

| Secret | 説明 |
|--------|------|
| `GEMINI_INBOUND_TIMEOUT_MS` | 1 回の解析タイムアウト（ms） |
| `INBOUND_RELEVANCE_CHECK` | `false` で無関係メール判定オフ |
| `INBOUND_MAKE_SOFT_FAIL` | `true` で例外時も 200 応答など |
| `INBOUND_BODY_FALLBACK_ON_GEMINI_TIMEOUT` | タイムアウト時のフォールバック制御 |
| `AUTO_MATCH_ENABLED` | 自動マッチング系の有効化 |

**`poll-email` 用（Graph ポーリング）**

| Secret | 説明 |
|--------|------|
| `GRAPH_CLIENT_ID` | Azure AD アプリ |
| `GRAPH_CLIENT_SECRET` | 同上 |
| `GRAPH_REFRESH_TOKEN_HUMAN` | 人材用 Outlook（prod） |
| `GRAPH_REFRESH_TOKEN_PROJECT` | 案件用 Outlook（prod） |
| `GRAPH_REFRESH_TOKEN_HUMAN_DEV` | 人材用（demo） |
| `GRAPH_REFRESH_TOKEN_PROJECT_DEV` | 案件用（demo） |

`poll-email` のソースでは、`inbound-email` 呼び出しに **JWT 形式**のキーを使う想定で **`INBOUND_CALL_KEY`**（service_role と同じ JWT でも可）を読む。未設定時は `SUPABASE_SERVICE_ROLE_KEY` 等のフォールバック順があるが、**運用ポリシーに合わせて明示設定を推奨**。

### 3.4 `inbound-email` の手動検証（最小）

Webhook と同じように JSON で叩ける（認証ヘッダはプロジェクトの設定に合わせる。通常は `Authorization: Bearer <anon または service_role>` と `apikey`）。

- `type`: `candidate` または `project`
- `from`, `subject`, `body`（空ばかりだとスキップされる動きあり）

詳細フィールド（添付・`attachments` 配列・`data_env` 等）は **`supabase/functions/inbound-email/index.ts` 先頭のコメント**が仕様の正である。

### 3.5 pg_cron の有効化（`add_email_polling_cron.sql`）

1. `add_email_polling_cron.sql` 内の `YOUR_PROJECT_REF` を実際の Reference ID に置換。
2. `YOUR_SERVICE_ROLE_KEY` を service_role キーに置換。
3. SQL Editor で実行。
4. ファイル末尾の `SELECT ... FROM cron.job` でジョブが登録されたことを確認。

---

## 第4章 Vercel（フロント本番）

1. Vercel にリポジトリをインポート。
2. Environment Variables に少なくとも以下を設定（`README.md` と同様）。

   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_GEMINI_API_KEY`
   - `VITE_AI_PROVIDER=gemini`
   - `VITE_DEMO_KEY`（任意）

3. `main` への push でデプロイされる想定なら、そのままビルド成功を確認。

---

## 第5章 メール連携（運用の要点）

### 5.1 標準経路（Graph + `poll-email`）

- Outlook の**未読**が対象。処理の流れは `README.md` のフロー図および「メール自動受信フロー」の節が正。
- リフレッシュトークンは **`app_config` にローテーション保存**されるため、初回だけ Secrets に入れれば以降は DB 側に寄っていく（異常時は Secrets / DB を確認）。

### 5.2 外部オートメーション経路（Make / Pipedream 等）

- `inbound-email` は **form-urlencoded / JSON** 双方や添付の複数表現に対応している。
- 外部ツール側で **本文が空・添付メタだけ**になるケースや、`from` が JSON 文字列になるケースがある。挙動は Edge 実装のパースロジックに従う。

### 5.3 よくある落とし穴

| 現象 | 確認すること |
|------|----------------|
| メールが DB に入らない | `inbound-email` ログ、`ai_logs`、無関係メール判定（`INBOUND_RELEVANCE_CHECK`） |
| ポーリングが動かない | `pg_cron` / `pg_net`、Secrets、`poll-email` のログ、cron ジョブ名 |
| デモと本番が混ざる | `data_env` / `mode` / クエリ `?demo=` と `VITE_DEMO_KEY`（README 参照） |

---

## 第6章 完了チェックリスト

- [ ] `npm run dev` で画面表示、`npm run build` 成功
- [ ] `schema.sql` + `migrations`（辞書順）適用済み
- [ ] `inbound-email` / `poll-email` デプロイ済み
- [ ] Secrets（Gemini・Supabase・Graph 系）設定済み
- [ ] （任意）pg_cron 登録済み
- [ ] （任意）Vercel 環境変数設定済み
- [ ] （任意）`npm run test:run` 成功

---

## 付録 A 参考ドキュメント（リポジトリ内）

| ファイル | 内容 |
|----------|------|
| `README.md` | 構成図・デプロイ・Secrets 一覧・ディレクトリ構成 |
| `CLAUDE.md` | プロジェクト方針・DB カテゴリ一覧・運用メモ |
| `supabase/functions/inbound-email/index.ts` | メール/Webhook ペイロード仕様（コメント） |
| `supabase/functions/poll-email/index.ts` | Graph ポーリング・必要 Secrets（コメント） |
| `docs/Sales_Manual.md` | 営業向け操作（あれば PDF 版も同梱） |

---

## 付録 B トラブル時の切り分け順

1. ブラウザの開発者ツール（ネットワーク）で Supabase へのリクエストが 401/403 になっていないか。
2. Supabase **Logs**（Edge Functions）で `inbound-email` / `poll-email` のエラー本文。
3. SQL Editor で `ai_logs` の直近行、テーブルに行が増えているか。
4. マイグレーションを飛ばしていないか（特に `add_candidate_skills.sql` と `add_data_env.sql`）。

---

*文書バージョン: リポジトリ同期用ドラフト。実際の Dashboard の文言・ボタン名は Supabase / Vercel / Azure の更新で変わる場合がある。*
