# AkiNavi HR-AI 環境構築ガイド

このガイドに沿って作業することで、**メール自動取り込みを含むシステム全体**を新しい環境でゼロから動かすことができます。

**作業時間の目安**: 3〜6時間（初回）

---

## 全体の流れ

```
第0章: Outlookアカウントを4つ作る
  ↓
第1章: 必要なツールのインストール・ソースコードの取得
  ↓
第2章: データベースの作成（Supabase）
  ↓
第3章: AIの設定（Gemini APIキーの取得）
  ↓
第4章: サーバー機能のデプロイ（Edge Functions）
  ↓
第5章: メール自動取り込みの設定（Azure + Microsoft Graph API）
  ↓
第6章: 本番サイトの公開（Vercel）
```

---

## 第0章　Outlookメールアドレスを4つ作る

### なぜ4つ必要か

このシステムは、専用のメールアドレスに転送・送信されたメールを自動で解析してデータベースに保存します。  
用途ごとに別のメールアドレスを使うため、合計4つ必要です。

| 用途 | 例 |
|---|---|
| 人材情報の受信（本番用） | `yourname.hr.human@outlook.jp` |
| 案件情報の受信（本番用） | `yourname.hr.project@outlook.jp` |
| 人材情報の受信（デモ用） | `yourname.hr.human.dev@outlook.jp` |
| 案件情報の受信（デモ用） | `yourname.hr.project.dev@outlook.jp` |

> **`yourname` の部分は自分で決めた名前や識別子に置き換えてください。**  
> 例：会社名・サービス名・自分のイニシャルなど。他の人がすでに使っているアドレスは取得できないため、ユニークになるよう工夫してください。  
> 例：`akinavi.hr.human@outlook.jp`、`tanaka2024.hr.human@outlook.jp` など

> **すべて同じ Microsoft アカウントではなく、それぞれ別のアカウントとして作成してください。** 1アカウント = 1メールアドレスです。

### なぜ Outlook（Microsoft）でないといけないのか

このシステムのメール自動取り込みは、**Microsoft Graph API** という仕組みを使ってメールを取得しています。  
Microsoft Graph API は **Microsoft のメールサービス（Outlook / Hotmail / Live）専用** のAPIです。

| メールサービス | 使えるか | 理由 |
|---|---|---|
| Outlook / Hotmail / Live（`@outlook.jp` / `@outlook.com` など） | **使える** | Microsoft Graph API に対応している |
| Gmail（`@gmail.com`） | **使えない** | Google のサービスのため Graph API が使えない |
| Yahoo!メール | **使えない** | 同上 |
| 会社の独自ドメインメール | 条件次第 | Microsoft 365（旧Office 365）のメールであれば対応可能だが設定が複雑になる |

> Gmail などを使いたい場合は、このシステムの `poll-email` Edge Function を Gmail の API（Google Workspace API）向けに作り直す必要があります。現状は対応していません。

### 作成手順（1アカウントあたり）

**1. Microsoftアカウント作成ページを開く**

ブラウザで `https://outlook.com` を開き、「無料アカウントを作成」をクリック。

---

**2. メールアドレスを決める**

「新しいメールアドレスを取得」を選び、希望のメールアドレスを入力して「次へ」。

---

**3. パスワード・名前・生年月日などを設定して完了**

---

**4. 同じ手順を繰り返す**

上記を 4回繰り返し、4つのアカウントを作成する。

> **重要**: 4つのメールアドレスと、それぞれのパスワードをメモしておいてください。後の章で使います。

### 完了チェック

- [ ] Outlookアカウントを4つ作成した
- [ ] 4つのメールアドレスとパスワードをメモした

---

## 第1章　必要なツールのインストール・ソースコードの取得

### 1-1. 必要なものを確認する

以下がインストールされているか確認してください。

**Node.js（バージョン20以上）**

ターミナルを開いて以下を入力し、バージョン番号が表示されればOKです。

```bash
node -v
```

`v20.x.x` のように表示されればOKです。表示されない場合は `https://nodejs.org` からインストールしてください。

---

**Git**

```bash
git --version
```

バージョンが表示されればOKです。表示されない場合は `https://git-scm.com` からインストールしてください。

---

**Supabase CLI**（後でサーバー機能をデプロイするために必要）

Mac の場合:

```bash
brew install supabase/tap/supabase
```

確認:

```bash
supabase --version
```

### 1-2. ソースコードをダウンロードする

「ソースコード」とは、このシステムのプログラム本体です。GitHub（プログラムの保管場所）からダウンロードします。

```bash
git clone https://github.com/kzmiyamura/akinavi-hr-ai.git
cd akinavi-hr-ai
```

### 1-3. 必要なパッケージをインストールする

プログラムが動くために必要な部品（ライブラリ）を一括インストールします。

```bash
npm install
```

完了までしばらく待ちます。エラーが出なければOKです。

### 完了チェック

- [ ] `node -v` でバージョンが表示された
- [ ] `git --version` でバージョンが表示された
- [ ] `supabase --version` でバージョンが表示された
- [ ] `npm install` がエラーなく完了した

---

## 第2章　データベースの作成（Supabase）

「データベース」とは、人材情報・案件情報などのデータを保存する場所です。このシステムでは **Supabase**（無料で使えるデータベースサービス）を使います。

### 2-1. Supabaseにサインアップ・プロジェクトを作成する

**1. `https://supabase.com` を開いてアカウントを作成する**

「Start your project」をクリック → GitHubアカウントでサインアップすると簡単です。

---

**2. 新しいプロジェクトを作成する**

ダッシュボードの「New project」をクリックし、以下を入力して「Create new project」。

- **Name**: 任意（例: `akinavi-hr-ai`）
- **Database Password**: 自分でパスワードを設定（**メモしておく**）
- **Region**: `Northeast Asia (Tokyo)` を選択

プロジェクトの作成が完了するまで1〜2分待ちます。

---

**3. 接続情報をメモする**

プロジェクトが作成されたら、左メニューの「Settings」→「API」を開く。

以下の2つをメモしてください:

| メモするもの | 場所 | 用途 |
|---|---|---|
| **Project URL** | 「Project URL」の欄 | アプリからDBへの接続先 |
| **anon（公開）キー** | 「Project API keys」の「anon」の欄 | アプリがDBに接続するための鍵 |
| **service_role キー** | 「Project API keys」の「service_role」の欄 | サーバー機能がDBを操作するための鍵（**絶対に他人に見せない**） |

### 2-2. 環境変数ファイルを作成する

「環境変数」とは、プログラムに渡す設定値（APIキーやURLなど）のことです。

```bash
cp .env.example .env.local
```

`.env.local` をテキストエディタで開き、以下を書き換えます（この時点では Gemini APIキーはまだなくてOKです）:

```env
VITE_SUPABASE_URL=（Project URL を貼り付け）
VITE_SUPABASE_ANON_KEY=（anon キーを貼り付け）
VITE_GEMINI_API_KEY=（次の章で設定します）
VITE_AI_PROVIDER=gemini
VITE_DEMO_KEY=（任意の文字列。例: demo2024）
```

### 2-3. データベースのテーブルを作成する

「テーブル」とは、データベースの中の表（Excel のシートのようなもの）です。SQLという命令文を実行して作成します。

**1. Supabase ダッシュボードの「SQL Editor」を開く**

左メニューの「SQL Editor」をクリック。

---

**2. `supabase/schema.sql` の中身を貼り付けて実行する**

ダウンロードしたソースコードの `supabase/schema.sql` をテキストエディタで開き、**全文をコピー**して SQL Editor に貼り付け、「Run」をクリック。

エラーが出なければOKです。

---

**3. 追加のSQLファイルを順番に実行する**

同じ手順で、以下のファイルを**上から順番に**実行してください。

| 順番 | ファイル名 | 内容 |
|---|---|---|
| 1 | `supabase/migrations/add_ai_logs.sql` | AI解析のログテーブル |
| 2 | `supabase/migrations/add_candidate_skills.sql` | スキルのカテゴリ分けテーブル |
| 3 | `supabase/migrations/add_data_env.sql` | 本番/デモの環境分けカラム |
| 4 | `supabase/migrations/add_project_detail_fields.sql` | 案件の詳細項目 |
| 5 | `supabase/migrations/add_projects_updated_by.sql` | 案件の更新者記録 |
| 6 | `supabase/migrations/add_updated_by.sql` | 人材の更新者記録 |

> `add_email_polling_cron.sql` は第5章で別途設定するため、今は実行しないでください。

### 2-4. ローカルで動作確認する

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開き、画面が表示されればOKです。

### 完了チェック

- [ ] Supabaseのプロジェクトを作成した
- [ ] Project URL・anon キー・service_role キーをメモした
- [ ] `.env.local` に URL と anon キーを設定した
- [ ] `schema.sql` を実行した
- [ ] 6つのマイグレーションSQLを順番に実行した
- [ ] `npm run dev` で画面が表示された

---

## 第3章　AIの設定（Gemini APIキーの取得）

このシステムはGoogle の AI（Gemini）を使ってメールや資料を自動解析します。  
利用するには「APIキー」（AIを使うための認証コード）が必要です。

### 3-1. Gemini APIキーを取得する

**1. `https://aistudio.google.com` をブラウザで開く**

Googleアカウントでログインします。

---

**2. 「Get API key」をクリック**

---

**3. 「Create API key」をクリックしてAPIキーを発行する**

表示されたキー（`AIza...` のような文字列）をメモしてください。

### 3-2. 環境変数に設定する

`.env.local` を開き、先ほどのキーを設定します:

```env
VITE_GEMINI_API_KEY=（取得したAPIキーを貼り付け）
```

### 3-3. 動作確認

```bash
npm run dev
```

「人材登録」タブを開き、適当なテキストを貼り付けて「解析して登録」をクリック。  
AIが解析を始めれば（またはエラーなく登録されれば）OKです。

### 完了チェック

- [ ] Google AI Studio で APIキーを取得した
- [ ] `.env.local` に `VITE_GEMINI_API_KEY` を設定した
- [ ] ブラウザからAI解析が動作した

---

## 第4章　サーバー機能のデプロイ（Edge Functions）

「Edge Functions」とは、Supabase のサーバー上で動くプログラムです。  
メールの自動解析（`inbound-email`）と Outlook のメール取得（`poll-email`）の2つをデプロイします。

### 4-1. Supabase CLIでログインする

```bash
npx supabase login
```

ブラウザが自動で開くのでログインしてください。

### 4-2. このプロジェクトに接続する

「Project Reference ID」（プロジェクトID）を Supabase ダッシュボードの「Settings」→「General」→「Reference ID」で確認してメモしてください。

```bash
npx supabase link --project-ref （Reference IDを貼り付け）
```

### 4-3. Edge Functions をデプロイする

```bash
npx supabase functions deploy inbound-email
npx supabase functions deploy poll-email
```

それぞれ「Deployed」と表示されればOKです。

### 4-4. Secrets（機密情報）を登録する

「Secrets」とは、サーバー上のプログラムが使うAPIキーやパスワードを安全に保管する場所です。  
Supabase ダッシュボード → 「Edge Functions」→「Secrets」から登録します。

「Add new secret」をクリックして、以下を1つずつ登録してください。

**必須（今すぐ登録）**

| Secret名 | 値 |
|---|---|
| `GEMINI_API_KEY` | 第3章で取得したGemini APIキー |
| `INBOUND_CALL_KEY` | Supabase の service_role キー（第2章でメモしたもの） |

> `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は Supabase が自動で設定するため、手動登録は不要な場合があります。もしエラーが出る場合は手動で追加してください。

**メール自動取り込み用（第5章で登録）**

| Secret名 | 用途 |
|---|---|
| `GRAPH_CLIENT_ID` | 第5章で取得 |
| `GRAPH_CLIENT_SECRET` | 第5章で取得 |
| `GRAPH_REFRESH_TOKEN_HUMAN` | 第5章で取得 |
| `GRAPH_REFRESH_TOKEN_PROJECT` | 第5章で取得 |
| `GRAPH_REFRESH_TOKEN_HUMAN_DEV` | 第5章で取得 |
| `GRAPH_REFRESH_TOKEN_PROJECT_DEV` | 第5章で取得 |

### 完了チェック

- [ ] `supabase login` が完了した
- [ ] `supabase link` でプロジェクトに接続した
- [ ] `inbound-email` をデプロイした
- [ ] `poll-email` をデプロイした
- [ ] `GEMINI_API_KEY` と `INBOUND_CALL_KEY` を Secrets に登録した

---

## 第5章　メール自動取り込みの設定

この章では、第0章で作成した4つのOutlookアカウントと、このシステムを連携させます。  
「5分ごとに未読メールを自動で取得・解析・保存する」という仕組みを作ります。

設定には3つのステップがあります。

```
① Azureにアプリを登録する（接続許可の設定）
② 各Outlookアカウントのリフレッシュトークンを取得する
③ Supabaseにスケジューラを登録する
```

### 5-1. Azureにアプリを登録する

「Azure」は Microsoft のクラウドサービスです。ここでアプリを登録することで、このシステムがOutlookにアクセスする許可を得ます。**Microsoftアカウントがあれば無料で使えます。**

**1. `https://portal.azure.com` をブラウザで開く**

Microsoftアカウント（Outlookアカウントのどれかでも可）でログインします。

---

**2. 「Microsoft Entra ID」を検索して開く**

上部の検索バーに「Microsoft Entra ID」と入力して選択します。

---

**3. 「アプリの登録」→「新規登録」をクリック**

---

**4. 以下を入力して「登録」をクリック**

| 項目 | 入力内容 |
|---|---|
| 名前 | 任意（例: `akinavi-mail-reader`） |
| サポートされるアカウントの種類 | 「**個人用 Microsoft アカウントのみ**」を選択 |
| リダイレクト URI | 「Web」を選び、`http://localhost` と入力 |

---

**5. クライアントIDをメモする**

登録完了画面に表示される「**アプリケーション（クライアント）ID**」をメモします。

---

**6. クライアントシークレットを作成する**

左メニュー「証明書とシークレット」→「新しいクライアントシークレット」→ 説明を入力して「追加」。

表示された「**値**」（`xxxxxxxx-xxxx-...` のような文字列）をメモします。  
**この画面を閉じると二度と確認できないので必ずメモしてください。**

---

**7. APIの権限を追加する**

左メニュー「APIのアクセス許可」→「アクセス許可の追加」→「Microsoft Graph」→「委任されたアクセス許可」で以下を検索して追加:

- `Mail.Read`
- `Mail.ReadWrite`

追加後、「（テナント名）に管理者の同意を与えます」のボタンが表示される場合はクリックしてください。

---

**メモしたもの**

- クライアントID（`GRAPH_CLIENT_ID`）
- クライアントシークレットの値（`GRAPH_CLIENT_SECRET`）

### 5-2. 各Outlookアカウントのリフレッシュトークンを取得する

「リフレッシュトークン」とは、このシステムがOutlookにアクセスし続けるための認証情報です。  
4つのアカウント分を取得します。

**1. 以下のURLをブラウザで開く**

`（クライアントID）` の部分を 5-1 でメモしたクライアントIDに置き換えてください。

```
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=（クライアントID）&response_type=code&redirect_uri=http://localhost&scope=offline_access%20Mail.Read%20Mail.ReadWrite
```

---

**2. 1つ目のOutlookアカウント（人材用・本番）でログインする**

ログインするとブラウザが `http://localhost/?code=（長い文字列）` というURLに遷移します。  
（ページは表示されませんが問題ありません）

アドレスバーの `code=` 以降の文字列を全部コピーしてメモします。

---

**3. コードをリフレッシュトークンに変換する**

ターミナルで以下を実行します（`（...）` 部分を実際の値に置き換え）:

```bash
curl -X POST https://login.microsoftonline.com/consumers/oauth2/v2.0/token \
  -d "client_id=（クライアントID）" \
  -d "client_secret=（クライアントシークレット）" \
  -d "redirect_uri=http://localhost" \
  -d "grant_type=authorization_code" \
  -d "code=（コピーしたcode）" \
  -d "scope=offline_access Mail.Read Mail.ReadWrite"
```

返ってきたJSON の `"refresh_token"` の値をメモします。これが **リフレッシュトークン**です。

---

**4. 残り3アカウント分も繰り返す**

同じ手順を残り3つのアカウントで繰り返します。ブラウザで別のアカウントにログインするときは、**一度ログアウトしてから**次のアカウントでログインしてください。

| アカウント | Secretキー名 |
|---|---|
| 人材用・本番 | `GRAPH_REFRESH_TOKEN_HUMAN` |
| 案件用・本番 | `GRAPH_REFRESH_TOKEN_PROJECT` |
| 人材用・デモ | `GRAPH_REFRESH_TOKEN_HUMAN_DEV` |
| 案件用・デモ | `GRAPH_REFRESH_TOKEN_PROJECT_DEV` |

---

**5. Supabase Secrets に登録する**

Supabase ダッシュボード → 「Edge Functions」→「Secrets」で、以下を登録します:

| Secret名 | 値 |
|---|---|
| `GRAPH_CLIENT_ID` | 5-1でメモしたクライアントID |
| `GRAPH_CLIENT_SECRET` | 5-1でメモしたクライアントシークレット |
| `GRAPH_REFRESH_TOKEN_HUMAN` | 人材用・本番のリフレッシュトークン |
| `GRAPH_REFRESH_TOKEN_PROJECT` | 案件用・本番のリフレッシュトークン |
| `GRAPH_REFRESH_TOKEN_HUMAN_DEV` | 人材用・デモのリフレッシュトークン |
| `GRAPH_REFRESH_TOKEN_PROJECT_DEV` | 案件用・デモのリフレッシュトークン |

### 5-3. 拡張機能を有効にする

Supabase のスケジューラ機能（pg_cron）と HTTP通信機能（pg_net）を有効にします。

Supabase ダッシュボード → 「Database」→「Extensions」を開き、以下を検索してONにします:

- `pg_cron`
- `pg_net`

### 5-4. 5分ごとのスケジュールを登録する

`supabase/migrations/add_email_polling_cron.sql` をテキストエディタで開き、以下の2箇所を書き換えます:

| 書き換え前 | 書き換え後 |
|---|---|
| `YOUR_PROJECT_REF` | Supabase の Reference ID（第4章でメモしたもの） |
| `YOUR_SERVICE_ROLE_KEY` | Supabase の service_role キー（第2章でメモしたもの） |

書き換えたら、Supabase の SQL Editor に全文貼り付けて「Run」をクリック。

最後の SELECT 結果に `poll-email-every-5-minutes` というジョブが表示されればOKです。

### 完了チェック

- [ ] Azureにアプリを登録し、クライアントID・シークレットをメモした
- [ ] Mail.Read / Mail.ReadWrite の権限を追加した
- [ ] 4つのアカウントのリフレッシュトークンを取得した
- [ ] 6つの Graph 関連 Secrets を Supabase に登録した
- [ ] pg_cron・pg_net を有効にした
- [ ] `add_email_polling_cron.sql` を書き換えて実行した

---

## 第6章　本番サイトの公開（Vercel）

「Vercel」とは、作ったWebサイトをインターネット上に公開するためのサービスです。無料で使えます。

### 6-1. Vercelにサインアップ・プロジェクトをインポートする

**1. `https://vercel.com` を開き、GitHubアカウントでサインアップ**

---

**2. 「Add New Project」→「Import Git Repository」でこのリポジトリを選択**

---

**3. 「Environment Variables」に以下を設定してから「Deploy」をクリック**

| 変数名 | 値 |
|---|---|
| `VITE_SUPABASE_URL` | Supabase の Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase の anon キー |
| `VITE_GEMINI_API_KEY` | Gemini の APIキー |
| `VITE_AI_PROVIDER` | `gemini` |
| `VITE_DEMO_KEY` | 任意の文字列（デモ環境の解除キー） |

デプロイが完了すると `https://（プロジェクト名）.vercel.app` のような URLが発行されます。

以降は `main` ブランチに変更を push するたびに自動でデプロイされます。

### 完了チェック

- [ ] Vercel にプロジェクトをインポートした
- [ ] 環境変数を設定した
- [ ] デプロイが成功してURLが発行された

---

## 最終確認チェックリスト

全章が完了したら、以下をすべて確認してください。

- [ ] `npm run dev` でブラウザにエラーなく画面が表示される
- [ ] 人材登録タブでテキストを貼り付けて「解析して登録」が動く
- [ ] マッチング結果タブでスコアが表示される
- [ ] 専用のOutlookアドレスにメールを送って5分以内に人材/案件が登録される
- [ ] Vercel の本番URLでも同じ動作が確認できる

---

## うまくいかないときは

### 画面が真っ白になる・エラーが出る

ブラウザの開発者ツールを開いて（F12 キー）、「Console」タブにエラーメッセージが出ていないか確認する。

よくある原因:
- `.env.local` の値が間違っている（スペースや余分な文字が入っていないか確認）
- `npm install` をしていない

### AIが解析されない（登録できない）

- Gemini APIキーが正しく設定されているか確認
- Supabase の「Edge Functions」→「Logs」でエラーが出ていないか確認

### メールが自動取り込みされない

Supabase の「Edge Functions」→「Logs」→「poll-email」のログを確認する。

よくある原因:
- Graph API の Secrets が1つでも登録されていない
- リフレッシュトークンが間違っている（取得後に有効期限が切れた場合は再取得が必要）
- `pg_cron` または `pg_net` が有効になっていない
- `add_email_polling_cron.sql` の `YOUR_PROJECT_REF` / `YOUR_SERVICE_ROLE_KEY` を書き換えずに実行してしまった

### マイグレーションでエラーが出る

- `schema.sql` を先に実行したか確認
- 同じSQLを二重実行していないか確認（多くのSQLは `IF NOT EXISTS` で二重実行に対応しているが念のため）

---

## 参考ドキュメント

| ファイル | 内容 |
|---|---|
| `README.md` | システム全体の概要・技術スタック |
| `docs/Sales_Manual.md` | 営業担当者向けの操作マニュアル |
| `docs/DataEnv_Demo_Prod.md` | 本番・デモ環境の切替方法 |
