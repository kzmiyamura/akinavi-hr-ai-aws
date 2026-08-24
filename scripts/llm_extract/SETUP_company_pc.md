# 会社PCへのワーカー移設 セットアップ確認書

**この文書は移設先（会社PC・Windows）の Claude Code に読ませて、上から順に実行させるためのもの。**
2026-08-24 作成。移設対象は LLM ワーカー（`scripts/llm_extract/shadow_worker.mjs`）。
移設元は ThinkCentre（`C:\Users\admin\Desktop\projects\akinavi-hr-ai-aws`）。

---

## 新PC側の Claude Code への指示

以下を **STEP 0 から順番に** 実行すること。各 STEP は「確認 → 無ければ導入」の形になっている。
**確認コマンドを必ず先に実行し、結果を見てから導入に進む**（入っているものを入れ直さない）。

STEP 8 のカットオーバーだけは**旧PC側の停止が先**なので、勝手に進めずユーザーに合図すること。

最後に「報告フォーマット」に従って結果をまとめること。

---

## STEP 0. 前提の把握

```powershell
$PSVersionTable.PSVersion          # PowerShell のバージョン
[System.Environment]::OSVersion    # Windows のバージョン
whoami                             # 実行ユーザー（このユーザーのホームに設定を置く）
Get-TimeZone                       # ★ 東京標準時であること
```

**タイムゾーンが JST でない場合は必ず直す。** ワーカーは日次上限（`dayCount`）を
日付でリセットするため、ズレると1日の処理件数が狂う。

```powershell
Set-TimeZone -Id "Tokyo Standard Time"   # 要管理者権限。ユーザーに依頼してよい
```

---

## STEP 1. Node.js（20以上・必須）

```powershell
node --version
npm --version
```

- **v20 以上なら OK**（移設元は v24.16.0 / npm 11.13.0）
- コマンド自体が見つからない、または v20 未満なら導入する:

```powershell
winget install OpenJS.NodeJS.LTS
```

導入後は**新しいターミナルを開き直してから** `node --version` で再確認する
（PATH が反映されない）。winget が使えない環境なら https://nodejs.org/ から LTS の
Windows Installer (.msi) をユーザーにインストールしてもらう。

---

## STEP 2. Git とリポジトリの clone

```powershell
git --version
```

無ければ `winget install Git.Git`。

**clone 済みかを確認する。** 想定パスは決め打ちしない（新PCのユーザー名が admin とは限らない）。
まず探す:

```powershell
Get-ChildItem -Path $HOME -Filter "akinavi-hr-ai-aws" -Directory -Recurse -Depth 4 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
```

見つかったディレクトリで、**正しいリポジトリか**を確認する:

```powershell
git -C <見つかったパス> remote -v      # origin が kzmiyamura/akinavi-hr-ai-aws であること
git -C <見つかったパス> log -1 --oneline
git -C <見つかったパス> status --short
```

見つからない、または別物だった場合は clone する（置き場所は下記を推奨）:

```powershell
New-Item -ItemType Directory -Force "$HOME\Desktop\projects"
git clone https://github.com/kzmiyamura/akinavi-hr-ai-aws.git "$HOME\Desktop\projects\akinavi-hr-ai-aws"
```

clone 済みだった場合は**最新にする**:

```powershell
git -C <パス> checkout main
git -C <パス> pull
```

> プライベートリポジトリなので、clone / pull で GitHub の認証を求められることがある。
> その場合はユーザーに対応してもらう（`gh auth login` またはブラウザ認証）。
> **Claude が認証情報を代わりに入力してはいけない。**

**以降、このパスを `$REPO` と呼ぶ。**

---

## STEP 3. 依存パッケージ

`node_modules` は git 管理外なので clone しただけでは入っていない。

```powershell
Test-Path "$REPO\node_modules"     # False なら未インストール
```

```powershell
npm --prefix $REPO install
```

完了後の確認:

```powershell
Test-Path "$REPO\node_modules\@supabase"    # True になること
```

---

## STEP 4. Claude CLI（`claude -p` が Max 枠で通ること）

ワーカーは AI 呼び出しに `claude -p` を使う。**ここが通らないとワーカーは動かない。**

```powershell
claude --version
```

インストール済みのはず（ユーザー確認済み）。無ければ:

```powershell
npm install -g @anthropic-ai/claude-code
```

### ログイン確認（最重要）

**会社が用意した別アカウント**でログインする（移設元とは別枠）。

```powershell
echo "1+1は?" | claude -p --model claude-haiku-4-5
```

- **答えが返れば OK。**
- 認証エラー・ログインを促された場合は、**ユーザーに `claude login` を実行してもらう**。
  ログインはブラウザを使う対話操作なので **Claude が代行してはいけない**。

### 実体パスの確認

ワーカーは Windows では `claude.exe` の実体を直接叩く（`caller.mjs` 対応済み）。
実体が見つかるか確認する:

```powershell
(Get-Command claude).Source
Test-Path "$env:APPDATA\npm\claude.exe"
```

どちらも空/False なら `caller.mjs` が起動できない可能性がある。その場合はログに
残る形で報告すること（STEP 7 の動作確認で必ず露見する）。

---

## STEP 5. 認証ファイル `~/.akinavi_shadow.env`

Supabase への接続情報。**git 管理外なので clone では入らない。**

```powershell
Test-Path "$HOME\.akinavi_shadow.env"
```

無ければ作る。中身は**2行だけ**:

```
export SUPABASE_URL=https://argizomylbolpqxgmvim.supabase.co
export SUPABASE_SERVICE_KEY=<service_role キー>
```

### ⚠ キーの受け渡しについて

- `SUPABASE_SERVICE_KEY` は **service_role キー**（DBを全権限で触れる）。
  旧PCの `~/.akinavi_shadow.env` と同じ値、または
  Supabase Dashboard → Project Settings → API Keys から取得できる。
- **Claude はこのキーをコマンドライン引数やチャットに書かないこと。**
  承認ダイアログの履歴やログに平文で残る。
  **ユーザーにエディタで直接貼り付けてもらうか、旧PCからファイルごとコピーしてもらう。**
- 絶対に git にコミットしない（`.gitignore` 対象外の場所にあるので事故に注意）。

アクセス権を本人のみに絞る:

```powershell
icacls "$HOME\.akinavi_shadow.env" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

---

## STEP 6. 状態ファイル `~/.akinavi_shadow_state.json`

処理済み位置（watermark）と日次カウンタを持つ。**旧PCからコピーするのが正解。**

```powershell
Test-Path "$HOME\.akinavi_shadow_state.json"
```

### 推奨: 旧PCの現物をコピーする

旧PC（ThinkCentre）の `C:\Users\admin\.akinavi_shadow_state.json` をそのまま持ってくる。
形式は次のとおり（2026-08-24 時点の実物）:

```json
{"watermark":"2026-08-10T01:31:15.55088+00:00","day":"2026-08-24","dayCount":57,
 "dayCost":5.396619649999999,"projWatermark":"2026-08-08T06:31:20.083Z","recDayCount":0}
```

**なぜコピーが正解か**: watermark を引き継がないと、未処理分の取りこぼし、または
処理済み分の再処理（＝Max枠の無駄使い）が起きる。`dayCount` も引き継がないと、
移設当日に日次上限（100件）を二重に使ってしまう。

### 旧PCから取れない場合のみ: 新規初期化

`scripts/llm_extract/init_state.mjs` を使う（インラインスクリプトを書かないこと）:

```powershell
node "$REPO\scripts\llm_extract\init_state.mjs"           # 確認のみ（書き込まない）
node "$REPO\scripts\llm_extract\init_state.mjs" --write   # 実際に初期化する
```

`--write` 無しが既定で、書き込む内容を表示するだけ。**まず確認だけ実行して内容を見ること。**

このスクリプトは watermark を「今」で初期化する。**それ以前の未処理人材は処理されない**
（7日で archive される）ことを承知した上で使うこと。既存ファイルがある場合は
`.bak` に退避してから上書きする。

旧PCの watermark の値だけ分かっているなら、それを渡すのが最善:

```powershell
node "$REPO\scripts\llm_extract\init_state.mjs" --write --watermark "2026-08-10T01:31:15.55088+00:00"
```

---

## STEP 7. pm2 で常駐化

```powershell
pm2 --version
```

無ければ:

```powershell
npm install -g pm2
```

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
pm2 list                                          # akinavi-shadow が online
Get-Content "$HOME\akinavi_shadow.log" -Tail 40
```

**期待するログ**:
- 起動時に `シャドーワーカー起動 watermark=...`
- 5分おきに `新規なし` または `新規候補者 N件` → `サイクル完了`
- 人材を処理したときは `haiku: proj=N verify=pass` など

**この時点で `↺`（再起動回数）が増え続けていたら異常。** ログのエラーを読んで報告する。
よくある原因: `~/.akinavi_shadow.env` が無い／キーが誤り（`SUPABASE_URL / SUPABASE_SERVICE_KEY
を設定してください` が出る）、`claude -p` が未ログイン。

### ログオン時の自動復元

```powershell
pm2 save
```

旧PCではスタートアップフォルダの `.cmd` で `pm2 resurrect` していた。同じものを作る:

```powershell
$startup = [Environment]::GetFolderPath('Startup')
Set-Content -Path "$startup\akinavi-pm2-resurrect.cmd" -Encoding ascii -Value @(
  '@echo off'
  '"%APPDATA%\npm\pm2.cmd" resurrect'
)
Get-Content "$startup\akinavi-pm2-resurrect.cmd"
```

> 旧PCでは `motion-lab-pm2-resurrect.cmd` に相乗りしていたが、**新PCには motion-lab が
> 無いので自前で作る必要がある**。ここを飛ばすと再起動後にワーカーが上がってこない。

### ⚠ スリープ・休止の無効化

常時稼働が前提。スリープすると5分サイクルが止まる。

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
```

Windows Update の自動再起動でも止まるが、上の `pm2 resurrect` で復帰する。

---

## STEP 8. カットオーバー（★ユーザーの合図を待つ）

**新旧2台を同時に動かしてはいけない。** 同じ人材を二重処理して Max 枠を無駄に使う
（データは upsert なので壊れはしないが、費用と枠が無駄になる）。

順番:

1. 新PCで STEP 7 まで正常を確認する
2. **ユーザーに「旧PC（ThinkCentre）のワーカーを止めてください」と伝える**
   旧PC側のコマンド: `pm2 stop akinavi-shadow` → `pm2 save`
   （`pm2 save` を忘れると次回ログオン時に旧PCで復活してしまう）
3. 旧PCの停止を確認後、新PCの状態ファイルを最新に更新（旧PC停止直前のものをコピー）
4. 新PCで `pm2 restart akinavi-shadow`
5. 30分ほどログを観察し、サイクルが回っていることを確認する

**旧PCのスタートアップ `.cmd` も無効化してもらう**（`motion-lab-pm2-resurrect.cmd` は
motion-lab 用なので削除はせず、旧PC側で `pm2 delete akinavi-shadow` → `pm2 save` する）。

---

## STEP 9. 移設後の確認（翌日）

```powershell
Get-Content "$HOME\akinavi_shadow.log" -Tail 100
pm2 list
```

- 1日分のログに `サイクル完了` が継続して出ているか
- `dayCount` が想定どおり増えているか（`Get-Content "$HOME\.akinavi_shadow_state.json"`）
- 処理結果の答え合わせ: `node "$REPO\scripts\llm_extract\apply_report.mjs" 1`

---

## 移設しなくてよいもの（確認不要）

| 要素 | 理由 |
|---|---|
| Supabase（DB・Edge Functions・Storage） | クラウド側。変更なし |
| Vercel（フロントエンド） | クラウド側。GitHub 連携で自動デプロイ。変更なし |
| Microsoft Graph の OAuth トークン | Supabase の `app_config` に保存されている |
| pg_cron の各種ジョブ | Supabase 側 |
| `testData/` | 実在の経歴書＝PII。git 管理外。**新PCに持ち込まない** |
| `node_modules` | STEP 3 で作り直す。コピーしない |

---

## 報告フォーマット

作業後、以下を埋めて報告すること。**「たぶん入っている」で済ませず、必ずコマンドの
実行結果を根拠にすること。**

```
■ 環境
- OS / TimeZone:
- Node.js:            (バージョン / 新規導入したか)
- Git:                (バージョン / 新規導入したか)
- リポジトリ:          (パス / clone 済みだったか新規 clone か / 最新コミット)
- npm install:        (実施したか / 所要)
- claude CLI:         (バージョン / `claude -p` の疎通結果 / ログイン操作が必要だったか)

■ 設定ファイル
- ~/.akinavi_shadow.env:         (既存 / 新規作成 / 誰が値を入れたか ※キーの値は書かない)
- ~/.akinavi_shadow_state.json:  (旧PCからコピー / 新規初期化 / watermark の値)

■ 常駐
- pm2:                (バージョン / 新規導入したか)
- pm2 list の状態:     (status / ↺ の回数)
- ログの最終行:        (実際の出力を貼る)
- pm2 save:           (実施したか)
- スタートアップ .cmd:  (作成したか / パス)
- スリープ無効化:      (実施したか)

■ カットオーバー
- 旧PC停止:           (未 / 依頼済み / 完了)
- 同時稼働の有無:      (無いこと確認済みか)

■ 詰まったこと・未解決
```

---

## 補足: このワーカーが何をしているか（新PC側の Claude 向け）

本番の regex パイプライン（Supabase Edge Function `inbound-email`）が登録した新規人材を
5分おきにポーリングし、`claude -p`（**Max サブスク枠・追加課金ゼロ**）で解析して
`candidates` を項目ごとの方針（`apply.mjs` の `FIELD_POLICY`）に従って補正する。

- 費用ゼロが絶対条件のため、AI は Edge Function 内では回せない（Max 枠は CLI 専用）。
  「regex が先に登録 → このPCの AI が後から直す」構造はそのため
- 日次上限: 人材解析 100件 / 提案所見 40件（別枠）
- ログの `cost=$N` は API 換算の参考値で**実課金ではない**
- 詳細は `scripts/llm_extract/HANDOFF_thinkcentre.md`（前回の移設記録）と
  リポジトリ直下の `CLAUDE.md` を読むこと

**本番データを扱うので、動作確認のために本番から大量にデータを引かないこと**
（`CLAUDE.md` の「Egress を使わずに検証する」を必ず読む）。
