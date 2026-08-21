# AkiNavi HR-AI 環境構築ガイド

このガイドに沿って作業すると、**メール自動取り込みと AI 処理を含むシステム全体**を新しい環境でゼロから動かせます。

- **想定PC**: Windows 10 / 11
- **作業時間の目安**: 4〜7時間（初回）
- **前提知識**: 不要。ターミナルの開き方から説明します

---

## 全体の流れ

```
第1章: Claude Code を用意する（会社アカウント）   ← まずここ
  ↓
第2章: Outlookアカウントを4つ作る
  ↓
第3章: 開発ツールの準備・ソースコードの取得
  ↓
第4章: データベースの作成（Supabase）
  ↓
第5章: AIのAPIキーを取る（Cerebras / Groq / Gemini）
  ↓
第6章: サーバー機能のデプロイ（Edge Functions）
  ↓
第7章: メール自動取り込みの設定（Azure + Microsoft Graph API）
  ↓
第8章: 本番サイトの公開（Vercel）
  ↓
第9章: AIワーカーを常駐させる（会社のClaudeに切り替える）
```

> 第2〜8章は Vercel と Supabase のダッシュボード上の作業が中心です。
> 第1章と第9章だけは**このシステムを動かすPC**での作業になります。

---

## このシステムで「AI」と呼んでいるもの

AI が2種類あり、**別のもの**です。混同すると設定を間違えるので最初に整理します。

| | 何をするか | どこで動くか | 何を使うか | 章 |
|---|---|---|---|---|
| **① マッチングの点数付け** | 案件と人材の相性を0〜100点で採点する | Supabase のサーバー | Cerebras → Groq → Gemini（3段） | 第5章 |
| **② 人材・案件の読み取りと所見** | 経歴書を読んで項目を直す／案件文を補う／「この人はここが効く」という所見を書く | **社内PC（このガイドのPC）** | **Claude Code** | 第1章・第9章 |

②が今回「私の Claude から会社の Claude に入れ替える」対象です。
具体的には、社内PCで動く常駐プログラム（シャドーワーカー）が Claude Code を呼び出して、

- **人材**: メール本文と経歴書を読み直して、氏名・年齢・経験年数・スキル年数などを補正する
- **案件**: 案件メールから抜けた項目を埋める
- **マッチング**: 提案ごとに「この案件はこういう人でないと通らない」「この方はこの経験が効く」という所見を書く
- **Box取込**: Box に置かれた経歴書を取ってきて解析する

を実行しています。**このPCで Claude Code がログインしているアカウントの枠が消費されます。** だから会社アカウントに切り替える必要があります。

---

## 第1章　Claude Code を用意する

### 1-0. Claude と Claude Code の違い

| | 何か |
|---|---|
| **Claude** | Anthropic 社の AI。ブラウザ（claude.ai）やスマホアプリで会話できる |
| **Claude Code** | 同じ Claude を**PCのコマンドから呼び出せるようにしたソフト**。ファイルを読んだり、プログラムから自動で呼び出したりできる |

このシステムが使うのは **Claude Code** のほうです。
料金は Claude の契約（Pro / Max などのサブスクリプション）に含まれます。**会社で契約したアカウントでログインすれば、その会社の枠が使われます。**

> **今なぜ切り替えるのか**
> 現在は個人の Claude アカウントでログインした状態で動いています。人材・案件・マッチングの AI 処理が動くたびに個人の利用枠が減っていくため、会社アカウントに切り替えます。

### 1-1. ターミナル（コマンドを打つ画面）を開く

「ターミナル」は、マウスではなく**文字でPCに命令する画面**です。Windows では **PowerShell** を使います。

**開き方（どちらでもOK）**

- **方法A**: キーボードの `Windows` キーを押す → `powershell` と入力 → 「**Windows PowerShell**」をクリック
- **方法B**: キーボードの `Windows` キーと `X` キーを同時に押す → メニューから「**ターミナル**」または「**Windows PowerShell**」をクリック

黒い（または紺色の）画面が開き、次のような行が出ていれば成功です。

```
PS C:\Users\あなたの名前>
```

この `>` の右側に文字を打って `Enter` キーを押すと、命令が実行されます。

> **この先の説明の読み方**
> グレーの枠に囲まれた行は、**そのままコピーしてターミナルに貼り付けて `Enter`** を押してください。
> 貼り付けは `Ctrl` + `V`、またはマウスの**右クリック**でできます。
> 打ち間違いを防ぐため、手で打たずコピーすることを強くおすすめします。

**困ったときのために覚えておくこと**

| やりたいこと | 操作 |
|---|---|
| 実行中の処理を止める | `Ctrl` + `C` |
| 画面をきれいにする | `cls` と入力して `Enter` |
| 直前に打った命令を出す | `↑` キー |
| ターミナルを閉じる | `exit` と入力して `Enter`、または右上の × |

### 1-2. Node.js をインストールする

Claude Code は **Node.js** というソフトの上で動きます。先にこれを入れます。

ターミナルに次を貼り付けて `Enter`:

```powershell
winget install OpenJS.NodeJS.LTS
```

インストールが終わったら、**ターミナルを一度閉じて開き直してください**（新しくインストールしたソフトは、開き直さないと認識されません）。

開き直したら、入ったかを確認します:

```powershell
node --version
```

`v20.19.0` のように **v から始まる数字**が表示されれば成功です。

> `winget` が「認識されていません」と出る場合は Windows が古い可能性があります。
> その場合は `https://nodejs.org` を開き、**LTS** と書かれた方のボタンからインストーラーをダウンロードして、画面の指示どおり「次へ」を押し続けてください。

### 1-3. Claude Code をインストールする

```powershell
npm install -g @anthropic-ai/claude-code
```

1〜3分かかります。途中で警告（黄色い文字）が出ても、最後にエラーで止まらなければ問題ありません。

終わったら**またターミナルを閉じて開き直し**、確認します:

```powershell
claude --version
```

`2.1.238 (Claude Code)` のような表示が出れば成功です。

### 1-4. 会社の Claude アカウントでログインする

**まず、今どのアカウントでログインしているか確認します。**

```powershell
claude auth status
```

個人アカウントのメールアドレスが表示されるはずです。**これを会社アカウントに入れ替えます。**

---

**1. 今のアカウントからログアウトする**

```powershell
claude auth logout
```

---

**2. 会社アカウントでログインする**

```powershell
claude auth login
```

ブラウザが自動で開きます。**会社で作ってもらった Claude アカウント**でログインし、画面の指示に従って許可してください。

> ブラウザが自動で開かない場合は、ターミナルに表示された `https://...` で始まるURLをコピーして、自分でブラウザのアドレス欄に貼り付けてください。
> **すでに個人アカウントでブラウザにログインしている場合**は、そのまま進むと個人アカウントで繋がってしまいます。
> ブラウザで先に個人アカウントからサインアウトするか、**シークレットウィンドウ**（`Ctrl` + `Shift` + `N`）でURLを開いてください。

---

**3. 会社アカウントに変わったことを確認する**

```powershell
claude auth status
```

**会社のメールアドレス**が表示されていればOKです。個人のアドレスのままなら、もう一度 1 からやり直してください。

### 1-5. ちゃんと動くか試す

```powershell
claude -p "こんにちは。1+1は？"
```

`2` といった返事が返ってくれば、AI が正しく呼び出せています。

> `-p` は「画面で会話せずに、答えだけ返す」という意味のオプションです。
> このシステムのワーカーも、この `claude -p` の形で AI を呼び出しています。

うまくいかないときは、次で状態を調べられます:

```powershell
claude doctor
```

### 1-6. よくあるつまずき

| 症状 | 原因と対処 |
|---|---|
| `claude` は認識されていません | ターミナルを閉じて開き直す。それでも駄目なら 1-3 をもう一度実行 |
| `npm` は認識されていません | Node.js が入っていない。1-2 をやり直し、必ずターミナルを開き直す |
| ログインしても個人アカウントのまま | ブラウザ側が個人アカウントでログイン済み。シークレットウィンドウでやり直す |
| `Usage limit reached` と出る | その時間帯の利用枠を使い切っている。時間をおくか、会社の契約プランを確認する |
| 途中で止まって戻ってこない | `Ctrl` + `C` で中断してやり直す |

### 完了チェック

- [ ] PowerShell を開けるようになった
- [ ] `node --version` でバージョンが表示される
- [ ] `claude --version` でバージョンが表示される
- [ ] `claude auth status` で**会社の**メールアドレスが表示される
- [ ] `claude -p "こんにちは"` で返事が返ってくる

---

## 第2章　Outlookメールアドレスを4つ作る

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

## 第3章　必要なツールの準備・ソースコードへのアクセス

### 3-1. 必要なツールをインストールする

第1章で Node.js は入っているので、残り2つを入れます。ターミナル（PowerShell）を開いて実行してください。

---

**Git**（ソースコードをダウンロードするツール）

```powershell
winget install Git.Git
```

インストール後は**ターミナルを閉じて開き直してから**確認します。

```powershell
git --version
```

`git version 2.51.0` のように表示されればOKです。

---

**Supabase CLI**（サーバー機能をデプロイするツール）

Supabase CLI は Scoop というインストーラー経由で入れます。まず Scoop を入れます。

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
```

> 1行目は「インターネットから取得したスクリプトの実行を許可する」設定です。`Y` を聞かれたら `Y` を入力して `Enter`。

続いて Supabase CLI 本体:

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

確認:

```powershell
supabase --version
```

バージョンが表示されればOKです。

> **Mac で作業する場合**は `brew install supabase/tap/supabase` で入ります。
> Git は Mac に最初から入っていることが多く、`git --version` で確認できます。

### 3-2. GitHubアカウントを作成する

「GitHub」とは、プログラムのソースコードを保管・管理するためのサービスです。ソースコードをダウンロードするために必要です。

**1. `https://github.com` を開いて「Sign up」からアカウントを作成する**

すでにアカウントがある場合はこの手順はスキップしてください。

---

**2. 作成したGitHubアカウントのユーザー名をメモする**

後の手順で担当者に伝える必要があります。

### 3-3. ソースコードへのアクセス権を担当者に依頼する

> **重要**: このシステムのソースコード（`akinavi-hr-ai`）は**非公開（Private）リポジトリ**です。  
> 担当者に許可してもらわないと、ソースコードをダウンロードすることができません。

**担当者に以下を伝えてください:**

```
GitHubのユーザー名: （3-2でメモしたユーザー名）
理由: akinavi-hr-ai のソースコードへのアクセス権（Collaborator）を付与してほしい
```

担当者が GitHub のリポジトリ設定からあなたを招待します。  
招待メールが届いたら「Accept invitation」をクリックして承諾してください。

> アクセス権が付与されるまでこの先の手順は進められません。担当者の対応を待ってください。

### 3-4. ソースコードをダウンロードする

アクセス権が付与されたら、ソースコードをダウンロードします。

まず、置き場所にするフォルダへ移動します（ここではデスクトップ）。

```powershell
cd $HOME\Desktop
```

ダウンロードします。

```powershell
git clone https://github.com/kzmiyamura/akinavi-hr-ai-aws.git
cd akinavi-hr-ai-aws
```

初回はブラウザか入力欄で GitHub のログインを求められます。第3章 3-2 で作ったアカウントでログインしてください。

> **これ以降のコマンドは、すべてこのフォルダの中で実行します。**
> ターミナルを開き直したら、先に `cd $HOME\Desktop\akinavi-hr-ai-aws` を実行して戻ってきてください。
> 今どこにいるかは `pwd` で確認できます。

### 完了チェック

- [ ] Git をインストールした
- [ ] Supabase CLI をインストールした
- [ ] GitHubアカウントを作成し、ユーザー名をメモした
- [ ] 担当者にアクセス権を依頼し、招待を承諾した
- [ ] `git clone` でソースコードをダウンロードした

---

## 第4章　データベースの作成（Supabase）

「データベース」とは、人材情報・案件情報などのデータを保存する場所です。このシステムでは **Supabase**（無料で使えるデータベースサービス）を使います。

### 4-1. Supabaseにサインアップ・プロジェクトを作成する

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

以下の3つをメモしてください（第8章のVercel設定で使います）:

| メモするもの | 場所 | 用途 |
|---|---|---|
| **Project URL** | 「Project URL」の欄 | アプリからDBへの接続先 |
| **anon（公開）キー** | 「Project API keys」の「anon」の欄 | アプリがDBに接続するための鍵 |
| **service_role キー** | 「Project API keys」の「service_role」の欄 | サーバー機能がDBを操作するための鍵（**絶対に他人に見せない**） |

### 4-2. データベースのテーブルを作成する

「テーブル」とは、データベースの中の表（Excel のシートのようなもの）です。SQLという命令文を実行して作成します。

**1. Supabase ダッシュボードの「SQL Editor」を開く**

左メニューの「SQL Editor」をクリック。

---

**2. `supabase/schema.sql` の中身を貼り付けて実行する**

ダウンロードしたソースコードの `supabase/schema.sql` をテキストエディタで開き、**全文をコピー**して SQL Editor に貼り付け、「Run」をクリック。

エラーが出なければOKです。

---

**3. 追加のSQLファイルを順番に実行する**

`supabase/migrations/` に **111 個**の SQL ファイルがあります（2026-08-21 時点）。
これを**ファイル名の昇順で全部**実行します。1つずつ手で貼るのは現実的でないので、コマンドでまとめて流します。

まず Supabase CLI をこのプロジェクトに繋ぎます（第6章 6-1・6-2 を先にやっても構いません）。

```powershell
supabase login
supabase link --project-ref （Reference ID）
```

つないだら、まとめて実行します。

```powershell
Get-ChildItem supabase\migrations\*.sql | Sort-Object Name | ForEach-Object {
  Write-Host "--- $($_.Name)"
  supabase db query --linked -f $_.FullName
}
```

> **Mac / Linux の場合**
> ```bash
> for f in $(ls supabase/migrations/*.sql | sort); do echo "--- $f"; supabase db query --linked -f "$f"; done
> ```

> **`supabase db push` は使いません。** このプロジェクトのマイグレーションは
> Supabase の管理テーブルと同期していないため、`db query` で1本ずつ流すのが正です。

---

**4. 途中でエラーが出たときの見方**

全部が一発で通るとは限りません。次の2つは**無視して先に進んで構いません**。

| メッセージ | 意味 |
|---|---|
| `already exists` | すでに作られている。二重実行なので問題なし |
| `does not exist`（DROP 系） | まだ無いものを消そうとしただけ。問題なし |

それ以外のエラーは、**そのファイル名を控えて**最後にもう一度流してください。
後のファイルが作ったものに依存している場合、2周目で通ります。

```powershell
supabase db query --linked -f supabase\migrations\（エラーになったファイル名）
```

---

**5. `*_cron.sql` だけは書き換えが必要**

ファイル名に `_cron` が付くものは、中に `YOUR_PROJECT_REF` / `YOUR_SERVICE_ROLE_KEY` という**穴埋め箇所**があります。
メモ帳などで開いて、第4章 4-1 でメモした値に置き換えてから実行してください。

| ファイル | 何のスケジュールか |
|---|---|
| `add_email_polling_cron.sql` | 5分ごとのメール取得（第7章で設定します） |
| `add_auto_match_cron.sql` | 毎朝 JST 9:00 の自動マッチング |
| `add_skill_cleanup_cron.sql` | 毎日 JST 3:00 のスキルマスタ整理 |
| `add_archive_candidates_cron.sql` | 毎日 JST 0:00 の人材アーカイブ（人材マップ用） |
| `add_enrich_cron.sql` | Box 連携の再解析（Box を使う場合のみ） |

---

**6. 実行できたか確認する**

Supabase ダッシュボードの「SQL Editor」で次を実行してください。

```sql
SELECT count(*) AS テーブル数 FROM information_schema.tables WHERE table_schema = 'public';
SELECT count(*) AS スキルマスタ件数 FROM skill_master;
SELECT count(*) AS 駅マスタ件数 FROM station_master;
```

- テーブル数が **15 以上**
- スキルマスタが **900 件以上**
- 駅マスタが **12,000 行以上**

になっていれば、マイグレーションは通っています。

> 駅マスタが 0 件のままだと、最寄駅から都道府県を推定できず勤務地のマッチングが効きません。
> `station_master` 系のマイグレーションが流れているか確認してください。

### 完了チェック

- [ ] Supabaseのプロジェクトを作成した
- [ ] Project URL・anon キー・service_role キーをメモした
- [ ] `schema.sql` を実行した
- [ ] `supabase/migrations/` 配下を**全て**ファイル名順に実行した
- [ ] `*_cron.sql` 系は `YOUR_PROJECT_REF` / `YOUR_SERVICE_ROLE_KEY` を置換した上で実行した
- [ ] テーブル数・skill_master・station_master の件数を確認した

---

## 第5章　AIの設定（APIキーの取得）

> **重要**: 2026-05-19 のコミット `139a4f2` でメール解析（`inbound-email`）から AI 利用が完全に除去され、コミット `a4dc3b4` でデッドコードも削除されました。
> 2026-05-22 のコミット `b35df40` で新しい **`match-batch`** Edge Function が導入され、マッチング処理は「ルールベース事前フィルタ + バッチ AI 採点」方式になりました。
> 現在 AI を使うのは **マッチング処理（`match-batch` / `match-score` / `auto-match`）** と **`poll-email` メール種別分類（任意・既定 OFF）** だけです。

| AI | 主な用途 | 必須度 |
|---|---|---|
| Cerebras | `match-batch` / `match-score` の **1 段目**（軽量・実質無制限） | 推奨（高速化に寄与） |
| Groq | `match-batch` / `match-score` の **2 段目**（高精度モデル `llama-3.3-70b-versatile`） | ◎ 必須 |
| Gemini | `match-batch` / `match-score` の **最終フォールバック**・`poll-email` 種別分類 | ◎ 必須 |

> **取得したAPIキーは第6章と第8章でまとめて登録します。ここではメモするだけでOKです。**
> 3 段すべて失敗してもルールスコアで全代替されるため、システム自体は止まりませんが、AI 採点なしでは品質が落ちるので必ず Groq と Gemini は登録してください。

### 5-1. Gemini APIキーを取得する（必須）

**1. `https://aistudio.google.com` をブラウザで開く**

Googleアカウントでログインします。

---

**2. 「Get API key」をクリック**

---

**3. 「Create API key」をクリックしてAPIキーを発行する**

表示されたキー（`AIza...` のような文字列）をメモしてください。

> Gemini はプリペイド制（従量課金）です。無料枠はありません。クレジット切れの場合は `auto-match` のスコア計算が失敗します。

### 5-2. Groq APIキーを取得する（必須）

Groq は `match-score`（手動マッチング）の 2 段目モデル（`llama-3.3-70b-versatile`）として使います。無料枠は 500K tokens/日（JST 9:00 リセット）で、マッチング用なら約 300 ペア/日に相当します。

**1. `https://console.groq.com` をブラウザで開く**

アカウントを作成（または Google アカウントでログイン）します。

---

**2. 「API Keys」→「Create API Key」でキーを発行する**

表示されたキー（`gsk_...` のような文字列）をメモしてください。

### 5-3. Cerebras APIキーを取得する（推奨）

Cerebras は `match-score` の 1 段目（軽量モデル `llama3.1-8b`）として使います。無料枠が非常に大きいため実質無制限で、ここで成功すれば Groq を消費しません。

**1. `https://cloud.cerebras.ai` をブラウザで開く**

アカウントを作成（または Google アカウントでログイン）します。

---

**2. 「API Keys」→「Generate API Key」でキーを発行する**

表示されたキーをメモしてください。

### 完了チェック

- [ ] Google AI Studio で Gemini APIキーを取得し、メモした（必須）
- [ ] Groq で APIキーを取得し、メモした（必須）
- [ ] Cerebras で APIキーを取得し、メモした（推奨）

---

## 第6章　サーバー機能のデプロイ（Edge Functions）

「Edge Functions」とは、Supabase のサーバー上で動くプログラムです。  
このシステムでは以下の Edge Functions をデプロイします。

| Edge Function | 役割 |
|---|---|
| `inbound-email` | メール解析（AI 不使用・regex + DB 照合のみ。`station_master` / `skill_master` はデプロイ物に同梱） |
| `poll-email` | Outlook のメール取得（5 分ごと cron） |
| `auto-match` | 毎朝 JST 9:00 の自動マッチング（`match-batch` を内部呼び出し） |
| `match-batch` | バッチ AI 採点（ルールスコア上位のみ 1 コールで採点） |
| `match-score` | 画面から呼ばれる単発スコア計算 |
| `archive-candidates` | 7 日経過人材のアーカイブ（毎日 JST 0:00 cron・人材マップ用） |
| `notify-candidates` | 人材ウォッチ通知メール送信（5 分ごと cron） |
| `microsoft-oauth` | Microsoft アカウント連携（OAuth コールバック） |
| `enrich-candidate` | Box 連携・再解析（Box 運用時のみ） |
| `skill-master-cleanup` | skill_master の毎日クリーンアップ |
| `cleanup-storage` | 添付ファイル Storage の掃除 |
| `create-github-issue` | 設定画面の「改善案・バグメモ」→ GitHub Issue |
| `verify-agent-license` | 派遣・職業紹介の許可番号チェック |
| `hf-proxy` | 外部モデル呼び出しの中継 |

### 6-1. Supabase CLIでログインする

```bash
npx supabase login
```

ブラウザが自動で開くのでログインしてください。

### 6-2. このプロジェクトに接続する

「Reference ID」（プロジェクトID）を Supabase ダッシュボードの「Settings」→「General」→「Reference ID」で確認してメモしてください。

```bash
cd akinavi-hr-ai
npx supabase link --project-ref （Reference IDを貼り付け）
```

### 6-3. Edge Functions をデプロイする

`supabase/functions/` にあるものを全部デプロイします。

```powershell
Get-ChildItem supabase\functions -Directory | ForEach-Object {
  Write-Host "--- $($_.Name)"
  supabase functions deploy $_.Name
}
```

> **Mac / Linux の場合**
> ```bash
> for d in supabase/functions/*/; do n=$(basename "$d"); echo "--- $n"; supabase functions deploy "$n"; done
> ```

1つだけデプロイし直したいときは関数名を指定します。

```powershell
supabase functions deploy inbound-email
```

> **`inbound-email` を直したときは、必ず型検査つきのスクリプトを使ってください。**
> ```powershell
> bash scripts/check-and-deploy-edge.sh inbound-email
> ```
> 未定義変数（TS2304）を検知して、エラーがあればデプロイを中止します。

それぞれ「Deployed」と表示されればOKです。

> **デプロイ前に型検査したい場合**は `npm run check:edge <function>` を使うと `deno check` で TS2304（未定義変数）を検知し、エラーがあればデプロイを中止できます。`npm run deploy:edge <function>` で「型検査 + デプロイ」をまとめて実行できます。引数を省略すると `inbound-email` を対象とします。

### 6-4. Secrets（機密情報）を登録する

「Secrets」とは、サーバー上のプログラムが使うAPIキーやパスワードを安全に保管する場所です。  
Supabase ダッシュボード → 「Edge Functions」→「Secrets」→「Add new secret」から登録します。

**今すぐ登録するもの**

| Secret名 | 値 | 必須 |
|---|---|---|
| `GEMINI_API_KEY` | 第5章でメモしたGemini APIキー（`auto-match` 等で使用） | ◎ |
| `GROQ_API_KEY` | 第5章でメモしたGroq APIキー（`match-score` で使用） | ◎ |
| `CEREBRAS_API_KEY` | 第5章でメモしたCerebras APIキー（`match-score` 1 段目） | 推奨 |
| `INBOUND_CALL_KEY` | 第4章でメモした service_role キー | ◎ |
| `GITHUB_TOKEN` | GitHub Personal Access Token（`repo` スコープ）。`create-github-issue` Edge Function 用 | Issue 連携を使う場合 |

> `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は Supabase が自動で設定するため、手動登録は不要です。もしエラーが出る場合は手動で追加してください。  
> `inbound-email` は AI を使わなくなったため、上記の API キーがなくてもメール解析自体は動きます。ただしマッチング処理が動かないと意味がないので必ず設定してください。

**第7章で追加登録するもの（今はスキップ）**

| Secret名 | 用途 |
|---|---|
| `GRAPH_CLIENT_ID` | 第7章で取得 |
| `GRAPH_CLIENT_SECRET` | 第7章で取得 |
| `GRAPH_REFRESH_TOKEN_HUMAN` | 第7章で取得 |
| `GRAPH_REFRESH_TOKEN_PROJECT` | 第7章で取得 |
| `GRAPH_REFRESH_TOKEN_HUMAN_DEV` | 第7章で取得 |
| `GRAPH_REFRESH_TOKEN_PROJECT_DEV` | 第7章で取得 |

**Box 連携を使う場合のみ**

| Secret名 | 用途 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Box → Drive 移送用キュー（スプレッドシート）アクセス |
| `BOX_SPREADSHEET_ID` | キュー用スプレッドシート ID |

**GitHub Token の取得手順**（Issue 連携を使う場合のみ）

1. `https://github.com/settings/tokens` を開き「Generate new token (classic)」を選択
2. 「Note」に任意の説明（例: `akinavi-issue-edge-function`）、「Expiration」を設定
3. 「Select scopes」で `repo`（フルアクセス）にチェック
4. 「Generate token」をクリックして表示された文字列（`ghp_...`）を Supabase Secrets `GITHUB_TOKEN` に登録
5. **`supabase/functions/create-github-issue/index.ts` の `REPO` 定数**（既定: `kzmiyamura/akinavi-hr-ai-aws`）を、自分のリポジトリに合わせて変更する場合はコード修正 + 再デプロイ

### 完了チェック

- [ ] `supabase login` が完了した
- [ ] `supabase link` でプロジェクトに接続した
- [ ] 全Edge Functions（14個）をデプロイした
- [ ] `GEMINI_API_KEY`・`GROQ_API_KEY`・`CEREBRAS_API_KEY`・`INBOUND_CALL_KEY` を Secrets に登録した
- [ ] （任意）Issue 連携を使う場合は `GITHUB_TOKEN` も登録した

---

## 第7章　メール自動取り込みの設定

この章では、第2章で作成した4つのOutlookアカウントと、このシステムを連携させます。  
「5分ごとに未読メールを自動で取得・解析・保存する」という仕組みを作ります。

設定には3つのステップがあります。

```
① Azureにアプリを登録する（接続許可の設定）
② 各Outlookアカウントのリフレッシュトークンを取得する
③ Supabaseにスケジューラを登録する
```

### 7-1. Azureにアプリを登録する

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

表示された「**値**」をメモします。  
**この画面を閉じると二度と確認できないので必ずメモしてください。**

---

**7. APIの権限を追加する**

左メニュー「APIのアクセス許可」→「アクセス許可の追加」→「Microsoft Graph」→「委任されたアクセス許可」で以下を検索して追加:

- `Mail.Read`
- `Mail.ReadWrite`

追加後、「（テナント名）に管理者の同意を与えます」のボタンが表示される場合はクリックしてください。

---

この時点でメモしたもの:

- クライアントID → Supabase Secrets の `GRAPH_CLIENT_ID` に登録
- クライアントシークレットの値 → Supabase Secrets の `GRAPH_CLIENT_SECRET` に登録

今すぐ Supabase ダッシュボード → 「Edge Functions」→「Secrets」に登録してください。

### 7-2. 各Outlookアカウントのリフレッシュトークンを取得する

「リフレッシュトークン」とは、このシステムがOutlookにアクセスし続けるための認証情報です。  
4つのアカウント分を取得します。

**1. 以下のURLをブラウザで開く**

`（クライアントID）` の部分を 7-1 でメモしたクライアントIDに置き換えてください。

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
| `GRAPH_REFRESH_TOKEN_HUMAN` | 人材用・本番のリフレッシュトークン |
| `GRAPH_REFRESH_TOKEN_PROJECT` | 案件用・本番のリフレッシュトークン |
| `GRAPH_REFRESH_TOKEN_HUMAN_DEV` | 人材用・デモのリフレッシュトークン |
| `GRAPH_REFRESH_TOKEN_PROJECT_DEV` | 案件用・デモのリフレッシュトークン |

### 7-3. 拡張機能を有効にする

Supabase のスケジューラ機能（pg_cron）と HTTP通信機能（pg_net）を有効にします。

Supabase ダッシュボード → 「Database」→「Extensions」を開き、以下を検索してONにします:

- `pg_cron`
- `pg_net`

### 7-4. 5分ごとのスケジュールを登録する

`supabase/migrations/add_email_polling_cron.sql` をテキストエディタで開き、以下の2箇所を書き換えます:

| 書き換え前 | 書き換え後 |
|---|---|
| `YOUR_PROJECT_REF` | Supabase の Reference ID（第6章でメモしたもの） |
| `YOUR_SERVICE_ROLE_KEY` | Supabase の service_role キー（第4章でメモしたもの） |

書き換えたら、Supabase の SQL Editor に全文貼り付けて「Run」をクリック。

最後の SELECT 結果に `poll-email-every-5-minutes` というジョブが表示されればOKです。

### 完了チェック

- [ ] Azureにアプリを登録し、クライアントID・シークレットをメモした
- [ ] Mail.Read / Mail.ReadWrite の権限を追加した
- [ ] `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` を Secrets に登録した
- [ ] 4つのアカウントのリフレッシュトークンを取得した
- [ ] 4つのリフレッシュトークンを Secrets に登録した
- [ ] pg_cron・pg_net を有効にした
- [ ] `add_email_polling_cron.sql` を書き換えて実行した

---

## 第8章　本番サイトの公開（Vercel）

「Vercel」とは、作ったWebサイトをインターネット上に公開するためのサービスです。無料で使えます。  
**ここで環境変数（設定値）をまとめて登録してデプロイすると、本番サイトが完成します。**

### 8-1. Vercelにサインアップ・プロジェクトをインポートする

**1. `https://vercel.com` を開き、GitHubアカウントでサインアップ**

---

**2. 「Add New Project」→「Import Git Repository」でこのリポジトリ（`akinavi-hr-ai`）を選択**

---

**3. 「Environment Variables」に以下をすべて入力する**

「Deploy」ボタンを押す**前に**、以下の環境変数を全部登録してください。

| 変数名 | 値 | メモした場所 |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase の Project URL | 第4章 |
| `VITE_SUPABASE_ANON_KEY` | Supabase の anon キー | 第4章 |
| `VITE_GEMINI_API_KEY` | Gemini の APIキー | 第5章 |
| `VITE_AI_PROVIDER` | `gemini`（そのまま入力） | — |
| `VITE_DEMO_KEY` | 任意の文字列（例: `demo2024`）| — |

> `VITE_DEMO_KEY` はデモ環境の解除キーです。自分で決めた文字列を設定してください。  
> 詳細は `docs/DataEnv_Demo_Prod.md` を参照。

---

**4. 「Deploy」をクリックする**

デプロイが完了すると `https://（プロジェクト名）.vercel.app` のような URLが発行されます。  
このURLが本番サイトのアドレスになります。

以降は `main` ブランチに変更を push するたびに**自動で再デプロイ**されます。

### 8-2. 環境変数を後から変更する場合

Vercel ダッシュボード → プロジェクトを選択 → 「Settings」→「Environment Variables」から変更できます。  
変更後は「Deployments」→「Redeploy」で再デプロイが必要です。

### 完了チェック

- [ ] Vercel にプロジェクトをインポートした
- [ ] 5つの環境変数をすべて設定した
- [ ] デプロイが成功してURLが発行された
- [ ] 発行されたURLでサイトが表示された

---

## 第9章　AIワーカーを常駐させる（会社のClaudeに切り替える）

第8章までで、サイトとメール取り込みは動きます。
この章では、**人材・案件・マッチングの AI 処理**を担当する常駐プログラム（シャドーワーカー）を、このPCで動かします。

### 9-0. このプログラムが何をしているか

`scripts/llm_extract/shadow_worker.mjs` が5分ごとに次の4つを回します。すべて**第1章でログインした Claude アカウント**の枠を使います。

| サイクル | 何をするか |
|---|---|
| 人材 | 新しく登録された人材のメール本文・経歴書を Claude が読み直し、氏名・年齢・経験年数・スキル年数などを補正する |
| 案件 | 新しい案件の抜けている項目を埋める |
| マッチング所見 | 提案ごとに「この案件はこういう人でないと通らない」「この方はこの経験が効く」という所見を書く |
| Box取込 | Box に置かれた経歴書を取得して解析する |

> **マッチングの点数そのものは Claude ではありません。** 点数は Supabase 側の
> ルール計算 + Cerebras / Groq / Gemini（第5章）です。ここで作るのは**点数の理由と所見**です。

### 9-1. 接続情報のファイルを作る

ワーカーがデータベースに書き込むための情報を、ホームフォルダにファイルとして置きます。

```powershell
notepad $HOME\.akinavi_shadow.env
```

「ファイルが見つかりません。新しく作成しますか？」と聞かれたら「はい」。
メモ帳が開くので、次の2行を貼り付けて**上書き保存**（`Ctrl` + `S`）してください。

```
SUPABASE_URL=（第4章 4-1 でメモした Project URL）
SUPABASE_SERVICE_KEY=（第4章 4-1 でメモした service_role キー）
```

> `service_role` キーはデータベースを何でも操作できる鍵です。**このファイルは絶対に他人に渡さず、GitHub にも上げないでください。**
> ファイル名の先頭がピリオド（`.`）である点に注意してください。

### 9-2. 手動で1回動かして確認する

いきなり常駐させず、まず手で動かして正常に回ることを見ます。

```powershell
cd $HOME\Desktop\akinavi-hr-ai-aws
node scripts/llm_extract/shadow_worker.mjs
```

次のような行が出れば起動成功です。

```
シャドーワーカー起動 watermark=...
```

5分ほど待つと「新規なし」または「新規候補者 N件」→「サイクル完了」が出ます。
確認できたら `Ctrl` + `C` で止めてください。

| 出たメッセージ | 対処 |
|---|---|
| `SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください` | 9-1 のファイルが読めていない。ファイル名（先頭のピリオド）と保存場所を確認 |
| `timeout` が続く | Claude の応答が返っていない。`claude -p "test"` が動くか第1章 1-5 で確認 |
| `Usage limit reached` | 会社アカウントの利用枠切れ。プランを確認 |

### 9-3. 常駐させる（pm2）

PCを再起動しても自動で動き続けるように、**pm2** という常駐管理ソフトを使います。

```powershell
npm install -g pm2
```

ワーカーを登録して起動します。

```powershell
cd $HOME\Desktop\akinavi-hr-ai-aws
pm2 start scripts/llm_extract/shadow_worker.mjs --name akinavi-shadow
pm2 save
```

`pm2 save` は「今動いているものを次回も復元する」という記録です。**忘れずに実行してください。**

**状態を見る**

```powershell
pm2 list
```

`akinavi-shadow` が `online` になっていればOKです。

**ログを見る**

```powershell
pm2 logs akinavi-shadow
```

見るのをやめるときは `Ctrl` + `C`（ワーカーは止まりません）。

**よく使う操作**

| やりたいこと | コマンド |
|---|---|
| 止める | `pm2 stop akinavi-shadow` |
| 再開する | `pm2 start akinavi-shadow` |
| 入れ替えたコードを反映する | `pm2 restart akinavi-shadow` |
| 設定（環境変数）も入れ直して再起動 | `pm2 restart akinavi-shadow --update-env` |
| 登録から消す | `pm2 delete akinavi-shadow` |

### 9-4. 個人アカウントから会社アカウントに切り替える手順

**すでに個人アカウントでワーカーが動いている場合**は、この順番で入れ替えてください。
順番を間違えると、切り替え途中の処理が個人枠で走ってしまいます。

**1. ワーカーを止める**

```powershell
pm2 stop akinavi-shadow
```

---

**2. Claude のアカウントを入れ替える**（第1章 1-4 と同じ）

```powershell
claude auth logout
claude auth login
claude auth status
```

`claude auth status` で**会社のメールアドレス**が出ることを必ず確認してください。

---

**3. 会社アカウントで AI が呼べるか確かめる**

```powershell
claude -p "こんにちは"
```

---

**4. ワーカーを再開する**

```powershell
pm2 restart akinavi-shadow --update-env
pm2 logs akinavi-shadow
```

ログに `サイクル完了` が出て、エラーが出ていなければ切り替え完了です。

---

**5. 別のPCでも動いていないか確認する**

> **重要**: 同じワーカーが2台で動いていると、**同じ人材を二重に処理して利用枠を無駄に使います**。
> 以前動かしていたPC（個人PC / 旧マシン）で止め忘れていないか必ず確認してください。
>
> - Windows: `pm2 stop akinavi-shadow`
> - Mac / Linux: `pkill -f shadow_worker`

### 9-5. 動作モードの切り替え

環境変数でふるまいを変えられます。値を変えたら `pm2 restart akinavi-shadow --update-env` が必要です。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `SHADOW_APPLY` | `1` | `0` にすると**記録だけ**して本番データを書き換えない（様子見用） |
| `SHADOW_DATA_ENV` | `prod` | `demo` にするとデモ環境のデータだけを処理する |
| `SHADOW_MAX_PER_DAY` | `100` | 1日に処理する人材の上限 |
| `SHADOW_REC_MAX_PER_DAY` | `100` | 1日に作るマッチング所見の上限 |

上限は**利用枠を使い切らないための安全装置**です。切り替え直後は小さめ（例: 20）にして、枠の減り方を見てから戻すのが安全です。

### 9-6. うまくいかないときの確認順

1. `pm2 list` — `akinavi-shadow` が `online` か
2. `pm2 logs akinavi-shadow` — エラーが出ていないか
3. `claude auth status` — 会社アカウントになっているか
4. `claude -p "test"` — Claude 単体で応答するか
5. `claude doctor` — Claude Code 自体の状態

### 完了チェック

- [ ] `~/.akinavi_shadow.env` を作った（2行）
- [ ] 手動起動で「シャドーワーカー起動」を確認した
- [ ] pm2 で常駐させ、`pm2 save` した
- [ ] `claude auth status` が**会社の**アカウントになっている
- [ ] 他のPCで同じワーカーが動いていないことを確認した

---

## 最終確認チェックリスト

全章が完了したら、以下を本番URLで確認してください。

- [ ] `claude auth status` が**会社の**アカウントになっている（第1章）
- [ ] `pm2 list` で `akinavi-shadow` が `online`（第9章）
- [ ] 本番URLでブラウザにエラーなく画面が表示される
- [ ] 「人材」タブでテキストを貼り付けて「登録」が動く（Phase 4.11 で「AI で登録」は廃止・登録ボタンに統一）
- [ ] 「マッチング」タブでスコアが表示される（スコア降順）
- [ ] マッチング詳細パネルに案件サマリー・ルールスコア内訳が表示される
- [ ] 専用のOutlookアドレスにメールを送って5分以内に人材/案件が登録される
- [ ] 「人材」タブの「人材マップ」ボタンから日本地図が表示され、都道府県が色付けされる
- [ ] **人材マップ**で都道府県をクリックすると地図がズームインし、下部にメール一覧が出る
- [ ] **人材マップ**でスキル名（例: `Java`）を入力するとオートコンプリート候補が出る
- [ ] **人材マップ**の「全期間」モードに切り替えてもエラーが出ない（`candidates_archive_light` の `name` / `subject` カラムが必要）
- [ ] 「設定」タブの「マッチング動作」で高速 / 全件モードを切り替えられる
- [ ] 「設定」タブの「改善案・バグメモ」でテストメモを入力し Issue 登録ができる（`GITHUB_TOKEN` 設定済みの場合）
- [ ] `[station_unmapped]` ログが Supabase Functions Logs に流れていないか確認（月次レビュー）
- [ ] 「通知」タブでルールを作ると、条件に合う人材の登録時にメールが届く
- [ ] 人材を1件登録して数分後に `pm2 logs akinavi-shadow` に処理ログが出る（AI補正が効いている）

---

## うまくいかないときは

### 画面が真っ白になる・エラーが出る

ブラウザの開発者ツールを開いて（F12 キー）、「Console」タブにエラーメッセージが出ていないか確認する。

よくある原因:
- Vercel の環境変数に誤りがある（スペースや余分な文字が入っていないか確認）
- 環境変数を設定後に再デプロイしていない

### AIが解析されない（登録できない）

- Vercel の `VITE_GEMINI_API_KEY` が正しく設定されているか確認
- Supabase の「Edge Functions」→「Logs」→「inbound-email」でエラーが出ていないか確認

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
| `docs/Outlook_AutoForward_Setup.md` | Outlook の自動転送設定 |
| `CLAUDE.md` | 開発時の決まりごと・運用ルール（開発者向け） |
| `scripts/llm_extract/README.md` | AIワーカーの設計（開発者向け） |
