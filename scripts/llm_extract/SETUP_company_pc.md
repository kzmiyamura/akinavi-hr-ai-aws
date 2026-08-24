# 会社PCへのワーカー移設 セットアップ手順書

**この文書は移設先（会社PC・Windows）の Claude Code が読んで実行するためのもの。**
2026-08-24 作成。移設対象は LLM ワーカー（`scripts/llm_extract/shadow_worker.mjs`）。
移設元は ThinkCentre（`C:\Users\admin\Desktop\projects\akinavi-hr-ai-aws`）。

---

# ★ 最初に読むこと: この作業の進め方

## 操作しているのはエンジニアではない

このPCを操作しているのは**営業部門の方**です。開発者ではありません。
次を必ず守ること。

| やること | やってはいけないこと |
|---|---|
| 自分で判断して進める | 「どうしますか」と技術的な選択を投げる |
| 平易な日本語で話す | pm2 / watermark / PATH / clone などの用語をそのまま使う |
| 進捗を一言で伝える（「Node.js を入れています。3分ほどかかります」） | コマンドやログをそのまま画面に流して説明を省く |
| 詰まったら「宮村さんに聞いてください」と案内する | 推測で強行する・仕様を勝手に変える |

**操作者に聞いてよいのは、物理的に本人にしかできない次の3つだけ。**

1. `claude login`（ブラウザでのログイン操作）
2. 設定ファイル `akinavi_shadow.env` の保存場所
3. 管理者権限が要る操作の可否（★印の工程。詳細は STEP 0）

それ以外は**全部自分でやること**。判断を仰がない。

## 詰まったときの扱い

このPCは**本番データを扱う**。勝手な回避策で進めないこと。
2回試して駄目なら、操作者にこう伝えて止まる。

> 「ここから先は開発者の判断が必要です。この画面をそのまま宮村さんに送ってください。」

## 本番データの取り扱い（重要）

動作確認のために**本番データベースから大量にデータを引かないこと**。
リポジトリ直下の `CLAUDE.md`「Egress を使わずに検証する」を必ず読むこと。
このセットアップで必要なDBアクセスは、ワーカー起動後の通常サイクルだけ。

---

# セットアップ

STEP 0 から順に実行する。各 STEP は「**確認 → 無ければ導入**」の形。
**確認コマンドを先に実行し、結果を見てから導入に進むこと**（入っているものを入れ直さない）。

STEP 8 のカットオーバーは旧PCの停止が先なので、**そこで必ず止まって操作者に伝えること**。

---

## STEP 0. 前提の把握

```powershell
$PSVersionTable.PSVersion
[System.Environment]::OSVersion
whoami
Get-TimeZone
```

### ★ タイムゾーン（管理者権限が要る場合あり）

**東京標準時でなければ直す。** ワーカーは日次の処理上限を日付でリセットするため、
ズレると1日の処理件数が狂う。

```powershell
Set-TimeZone -Id "Tokyo Standard Time"
```

権限エラーになったら、操作者にこう伝える:

> 「PCの時刻設定を東京時間に変える必要がありますが、権限が足りません。
> 管理者権限をお持ちですか。無ければ情シスの方への依頼になります。」

**この時点で止まらず、他の STEP は先に進めてよい**（最後にまとめて報告する）。

---

## STEP 1. Node.js（20以上・必須）

```powershell
node --version
npm --version
```

- **v20 以上なら OK**（移設元は v24.16.0 / npm 11.13.0）
- 見つからない、または v20 未満なら導入する:

```powershell
winget install OpenJS.NodeJS.LTS
```

★ 管理者権限が要る場合がある。エラーになったら STEP 0 と同じ要領で操作者に伝える。

導入後は**新しいターミナルで** `node --version` を再確認する（PATH が反映されないため）。
winget が使えない場合は、操作者に https://nodejs.org/ から LTS 版のインストールを依頼する。

> 操作者への伝え方の例:
> 「プログラムを動かすための土台（Node.js）を入れます。5分ほどかかります。」

---

## STEP 2. Git とリポジトリ

```powershell
git --version
```

無ければ `winget install Git.Git`（★ 権限が要る場合あり）。

### clone 済みかを確認する

パスを決め打ちしないこと（ユーザー名が admin とは限らない）。まず探す:

```powershell
Get-ChildItem -Path $HOME -Filter "akinavi-hr-ai-aws" -Directory -Recurse -Depth 4 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
```

見つかったら**正しいリポジトリか**照合する:

```powershell
git -C <パス> remote -v          # origin が kzmiyamura/akinavi-hr-ai-aws であること
git -C <パス> log -1 --oneline
git -C <パス> status --short
```

- **正しければ最新にする**: `git -C <パス> checkout main` → `git -C <パス> pull`
- 見つからない/別物なら clone する:

```powershell
New-Item -ItemType Directory -Force "$HOME\Desktop\projects"
git clone https://github.com/kzmiyamura/akinavi-hr-ai-aws.git "$HOME\Desktop\projects\akinavi-hr-ai-aws"
```

> プライベートリポジトリなので GitHub の認証を求められることがある。
> **Claude が認証情報を代行入力してはいけない。** 操作者に画面を渡し、
> 分からなければ宮村さんに聞いてもらう。

**以降、このパスを `$REPO` と呼ぶ。** PowerShell 変数に入れておくとよい。

---

## STEP 3. 依存パッケージ

`node_modules` は git 管理外なので、clone しただけでは入っていない。

```powershell
Test-Path "$REPO\node_modules"
```

False なら:

```powershell
npm --prefix $REPO install
```

確認: `Test-Path "$REPO\node_modules\@supabase"` が True になること。

> 操作者への伝え方: 「必要な部品をダウンロードしています。数分かかります。」

---

## STEP 4. Claude CLI とログイン

ワーカーは AI 呼び出しに `claude -p` を使う。**ここが通らないとワーカーは動かない。**

```powershell
claude --version
```

無ければ `npm install -g @anthropic-ai/claude-code`。

### ログイン確認（操作者の手が要る工程 その1）

**会社が用意した Claude アカウント**でログインする。

```powershell
echo "1+1は?" | claude -p --model claude-haiku-4-5
```

- **答えが返れば OK。** STEP 5 へ進む。
- 認証エラーやログインを促された場合、操作者にこう伝える:

> 「AI に接続するため、会社の Claude アカウントでのログインが必要です。
> ブラウザが開きますので、会社のアカウントでログインしてください。
> 終わったら『ログインしました』と教えてください。」

その上で `claude login` を実行する。**Claude がパスワードを代わりに入力してはいけない。**

### 実体パスの確認

ワーカーは Windows では `claude.exe` の実体を直接叩く（`caller.mjs` 対応済み）。

```powershell
(Get-Command claude).Source
Test-Path "$env:APPDATA\npm\claude.exe"
```

両方とも空/False なら STEP 7 の起動で失敗する。その場合は報告に残すこと。

---

## STEP 5. 設定ファイル `~/.akinavi_shadow.env`（操作者の手が要る工程 その2）

Supabase への接続情報。**git 管理外なので clone では入らない。**
宮村さんから LINE WORKS で `akinavi_shadow.env` というファイルが届いているはず。

```powershell
Test-Path "$HOME\.akinavi_shadow.env"
```

True ならこの STEP は完了。False なら以下。

### 届いたファイルを探す

まず自分で探す（操作者に聞く前に）:

```powershell
Get-ChildItem -Path "$HOME\Downloads","$HOME\Desktop","$HOME\Documents" `
  -Filter "*akinavi_shadow*" -Recurse -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime
```

見つからなければ操作者に聞く:

> 「宮村さんから届いた設定ファイル（akinavi_shadow.env）を保存した場所を教えてください。
> ダウンロードフォルダにあることが多いです。」

### 所定の場所に配置する

ホームフォルダ直下に、**先頭にドットを付けた名前**でコピーする
（エクスプローラでは作りにくいのでコマンドで行う）:

```powershell
Copy-Item "<見つかったファイルのパス>" "$HOME\.akinavi_shadow.env"
```

### 中身の検証（値は表示しない）

```powershell
(Get-Content "$HOME\.akinavi_shadow.env") -replace '=.*', '=<省略>'
```

**期待する結果**（2行）:

```
export SUPABASE_URL=<省略>
export SUPABASE_SERVICE_KEY=<省略>
```

- **キーの値そのものを画面に出さないこと。** DB全権限を持つ認証情報であり、
  ログや承認履歴に平文で残ると事故になる
- **絶対に git にコミットしない**
- 行数が違う、キー名が違う場合は宮村さんに確認してもらう

### アクセス権を絞る

```powershell
icacls "$HOME\.akinavi_shadow.env" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

---

## STEP 6. 状態ファイル `~/.akinavi_shadow_state.json`

処理済み位置（watermark）と日次カウンタを持つ。

```powershell
Test-Path "$HOME\.akinavi_shadow_state.json"
```

### 原則: 旧PCの現物を使う

宮村さんが設定ファイルと一緒に `akinavi_shadow_state.json` も送っている場合、
それを `$HOME\.akinavi_shadow_state.json` にコピーする（STEP 5 と同じ要領・先頭にドット）。

**なぜ現物が正解か**: 引き継がないと、未処理分の取りこぼしか、処理済み分の再処理
（＝AI利用枠の無駄使い）が起きる。日次カウンタも引き継がないと、移設当日に
上限を二重に使ってしまう。

### 届いていない場合

`init_state.mjs` を使う。**インラインスクリプト（node -e）は書かないこと。**

```powershell
node "$REPO\scripts\llm_extract\init_state.mjs"           # 確認のみ（書き込まない）
node "$REPO\scripts\llm_extract\init_state.mjs" --write   # 実際に初期化する
```

`--write` 無しが既定で、書き込む予定の内容を表示するだけ。**まず確認だけ実行すること。**

watermark は「今」で初期化される。**それ以前に登録された未処理の人材は AI 補正されない**
（7日で archive される）。これは実害があるので、**実行前に報告に記録すること**。

旧PCの watermark の値だけ分かっているなら、それを渡すのが最善:

```powershell
node "$REPO\scripts\llm_extract\init_state.mjs" --write --watermark "<旧PCの値>"
```

---

## STEP 7. 常駐化（pm2）

```powershell
pm2 --version
```

無ければ `npm install -g pm2`。

### 起動

ワーカーは `~/.akinavi_shadow.env` を**自分で読む**ので、pm2 側で環境変数を渡す必要はない。

```powershell
pm2 start "$REPO\scripts\llm_extract\shadow_worker.mjs" `
  --name akinavi-shadow `
  --cwd $REPO `
  --output "$HOME\akinavi_shadow.log" `
  --error  "$HOME\akinavi_shadow.log"
```

### 動作確認（ここが本番）

```powershell
pm2 list
Get-Content "$HOME\akinavi_shadow.log" -Tail 40
```

**期待するログ**:
- 起動時に `シャドーワーカー起動 watermark=...`
- 5分おきに `新規なし` または `新規候補者 N件` → `サイクル完了`
- 人材を処理したときは `haiku: proj=N verify=pass` など

**`↺`（再起動回数）が増え続けていたら異常。** ログのエラーを読むこと。よくある原因:

| ログ | 原因 |
|---|---|
| `SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください` | STEP 5 の配置ミス（ドット付きファイル名になっているか確認） |
| 認証エラー・`claude` 関連のエラー | STEP 4 のログイン未完了 |
| `Cannot find module` | STEP 3 の `npm install` 未実施 |

**最低5分は観察して、1サイクル回ることを確認してから次へ進むこと。**

### ログオン時の自動復元

```powershell
pm2 save
```

さらに**スタートアップに復元用ファイルを作る**。旧PCでは別プログラム用のファイルに
相乗りしていたが、**このPCには無いので自前で作る必要がある**。
ここを飛ばすと再起動後にワーカーが上がってこない。

```powershell
$startup = [Environment]::GetFolderPath('Startup')
Set-Content -Path "$startup\akinavi-pm2-resurrect.cmd" -Encoding ascii -Value @(
  '@echo off'
  '"%APPDATA%\npm\pm2.cmd" resurrect'
)
Get-Content "$startup\akinavi-pm2-resurrect.cmd"
```

### ★ スリープ・休止の無効化

常時稼働が前提。スリープすると5分サイクルが止まる。

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
```

★ 権限エラーになったら操作者に伝える（画面が消えるのは問題ないが、
スリープすると処理が止まることを説明する）。

---

## STEP 8. カットオーバー（★ここで必ず止まる）

**新旧2台を同時に動かしてはいけない。** 同じ人材を二重処理して AI 利用枠を無駄に使う
（データは upsert なので壊れはしないが、枠と時間が無駄になる）。

**自分で進めず、操作者にこう伝えること:**

> 「このPCでの準備が終わりました。
> いまは元のPCでも同じプログラムが動いているので、**両方が動いている状態**です。
> 宮村さんに『新しいPCの準備ができたので、元のPCを止めてください』と連絡してください。
> 止まったら教えてください。続きを行います。」

宮村さん側の作業（旧PC）:
```powershell
pm2 stop akinavi-shadow
pm2 delete akinavi-shadow
pm2 save
```

旧PC停止の連絡を受けたら:

1. 旧PCの最新の状態ファイルが届いていれば差し替える（STEP 6 の要領）
2. `pm2 restart akinavi-shadow`
3. 30分ほどログを観察し、サイクルが回っていることを確認する

---

## STEP 9. 最終確認

```powershell
pm2 list
Get-Content "$HOME\akinavi_shadow.log" -Tail 60
Get-Content "$HOME\.akinavi_shadow_state.json"
```

- `status` が `online`、`↺` が増えていないこと
- ログに `サイクル完了` が継続して出ていること

---

# 移設しなくてよいもの（確認不要）

| 要素 | 理由 |
|---|---|
| Supabase（DB・Edge Functions・Storage） | クラウド側。変更なし |
| Vercel（フロントエンド） | クラウド側。GitHub 連携で自動デプロイ。変更なし |
| `.env.local`（フロントの環境変数） | **不要。** Vercel が持っている。営業PCには要らない |
| Microsoft Graph の OAuth トークン | Supabase の `app_config` に保存されている |
| pg_cron の各種ジョブ | Supabase 側 |
| `testData/` | 実在の経歴書＝個人情報。git 管理外。**持ち込まない** |
| `node_modules` | STEP 3 で作り直す。コピーしない |

---

# 報告フォーマット

**最後にこれを埋めて、操作者に「これをコピーして宮村さんに送ってください」と伝えること。**
「たぶん入っている」で済ませず、必ずコマンドの実行結果を根拠にすること。

```
■ 環境
- OS / TimeZone:      (変更が必要だったか / できたか)
- Node.js:            (バージョン / 新規導入したか)
- Git:                (バージョン / 新規導入したか)
- リポジトリ:          (パス / clone済みだったか新規cloneか / 最新コミット)
- npm install:        (実施したか)
- claude CLI:         (バージョン / 疎通OKか / ログイン操作が必要だったか)

■ 設定ファイル
- .akinavi_shadow.env:        (既存 / LINE WORKS から配置 / 2行あるか ※値は書かない)
- .akinavi_shadow_state.json: (旧PCからコピー / 新規初期化 / watermark の値)
  ※新規初期化した場合は「この日時より前の未処理人材は補正されません」と明記

■ 常駐
- pm2:                (バージョン / 新規導入したか)
- pm2 list:           (status / ↺ の回数)
- ログの最終行:        (実際の出力を貼る)
- pm2 save:           (実施したか)
- スタートアップ .cmd:  (作成したか)
- スリープ無効化:      (実施したか / 権限不足なら明記)

■ 管理者権限が必要で実施できなかった項目
  (無ければ「なし」)

■ カットオーバー
- 旧PC停止:           (未 / 依頼済み / 完了)
- 同時稼働の有無:      (無いこと確認済みか)

■ 詰まったこと・未解決
```

---

# 補足: このワーカーが何をしているか

本番の regex パイプライン（Supabase Edge Function `inbound-email`）が登録した新規人材を
5分おきにポーリングし、`claude -p`（**サブスク枠・追加課金ゼロ**）で解析して
`candidates` を項目ごとの方針（`apply.mjs` の `FIELD_POLICY`）に従って補正する。

- 費用ゼロが絶対条件のため、AI は Edge Function 内では回せない（サブスク枠は CLI 専用）。
  「regex が先に登録 → このPCの AI が後から直す」構造はそのため
- 日次上限: 人材解析 100件 / 提案所見 40件（別枠）
- ログの `cost=$N` は API 換算の参考値で**実課金ではない**
- 詳細は `scripts/llm_extract/HANDOFF_thinkcentre.md`（前回の移設記録）と
  リポジトリ直下の `CLAUDE.md` を読むこと
