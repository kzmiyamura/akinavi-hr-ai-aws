# シャドーワーカー移設引き継ぎ書（Mac → ThinkCentre）

**この文書は ThinkCentre 上の Claude Code に読ませて実行させるための手順書。**
2026-08-07 作成。移設対象は LLM シャドーワーカー（`scripts/llm_extract/shadow_worker.mjs`）。

## 背景（ThinkCentre側のClaudeへ）
- このワーカーは、本番regexパイプラインが登録した新規候補者を5分おきにポーリングし、
  `claude -p`（**Maxサブスク枠・追加課金ゼロ**）で Haiku→機械検証→Sonnet昇格ルーターを回して
  `llm_shadow` テーブルに並記録する。**本番フィールドには一切書き込まない**。
- いままで M1 Mac で `nohup` 常駐していたが、常時稼働機のThinkCentreに移す。
- 方針: 本番LLM化の本命は claude -p（ユーザー決定・2026-08-07）。費用ゼロが絶対条件。

## 前提条件（最初に確認すること）
1. **Node.js 20以上**: `node --version`
2. **claude CLI がこのMaxアカウントでログイン済み**:
   `echo "1+1は?" | claude -p --model claude-haiku-4-5` が答えを返せばOK
3. このリポジトリが clone 済みであること（この文書が読めていれば済んでいる）

## セットアップ手順

### 1. 環境変数ファイル `~/.akinavi_shadow.env` を作る
中身は2行だけ。**値はユーザーに聞くこと**（Mac側の `~/.akinavi_shadow.env` と同一。
または Supabase Dashboard → Project Settings → API の URL と service_role key）:

```bash
export SUPABASE_URL=https://argizomylbolpqxgmvim.supabase.co
export SUPABASE_SERVICE_KEY=<service_role キー。ユーザーから受け取る>
```

`chmod 600 ~/.akinavi_shadow.env` にすること。**このファイルは絶対にgitにコミットしない。**

### 2. state ファイルを初期化する
二重処理を避けるため、watermark を「今」で初期化（過去分はMac側で処理済み）:

```bash
node -e 'const fs=require("fs"),os=require("os");fs.writeFileSync(os.homedir()+"/.akinavi_shadow_state.json",JSON.stringify({watermark:new Date().toISOString(),day:"",dayCount:0,dayCost:0}))'
```

### 3. 起動する
**Linux (systemd) 推奨** — ユーザーサービスとして常駐させる:

```ini
# ~/.config/systemd/user/akinavi-shadow.service
[Unit]
Description=AkiNavi LLM shadow worker

[Service]
Type=simple
WorkingDirectory=%h/akinavi-hr-ai-aws
ExecStart=/bin/bash -c 'source %h/.akinavi_shadow.env && exec node scripts/llm_extract/shadow_worker.mjs'
Restart=always
RestartSec=60
StandardOutput=append:%h/akinavi_shadow.log
StandardError=append:%h/akinavi_shadow.log

[Install]
WantedBy=default.target
```

```bash
# WorkingDirectory は実際の clone 先に合わせて書き換えること
systemctl --user daemon-reload
systemctl --user enable --now akinavi-shadow
loginctl enable-linger $USER   # ログアウト後も動かし続ける
```

systemd が使えない環境（WSL初期状態・Windows等）は nohup でも可:
```bash
source ~/.akinavi_shadow.env
nohup node scripts/llm_extract/shadow_worker.mjs >> ~/akinavi_shadow.log 2>&1 & disown
```

### 4. 動作確認
```bash
tail -f ~/akinavi_shadow.log
# 「シャドーワーカー起動 watermark=...」が出て、5分おきに
# 「新規なし」または「新規候補者 N件」→「サイクル完了」が出ればOK
# claude -p タイムアウトは180sに設定済み。エラーが連発したらログをユーザーに見せる
```

新規候補者が流れる時間帯（平日日中）なら、llm_shadow に行が増えることも確認:
処理ログに `haiku: proj=N verify=pass` 等が出る。

### 5. カットオーバー（重要・最後に必ず）
ThinkCentre側で正常サイクルを確認したら、**ユーザーに「Mac側のワーカーを止めてください」と伝える**。
Mac側での停止コマンド: `pkill -f shadow_worker`
（両方動いていると同じ候補者を二重処理してMax枠を無駄に消費する。データは upsert なので壊れはしない）

## 移設完了メモ（2026-08-07・ThinkCentre = Windows 11 で実施済み）
- ThinkCentre は Windows だったため systemd/nohup ではなく **pm2** で常駐化した
  （既存の motion-lab が pm2 + スタートアップの `motion-lab-pm2-resurrect.cmd` で
  常駐しており、同じ仕組みに相乗り。`pm2 save` 済みなのでログオン時に自動復元される）
- プロセス名: `akinavi-shadow`。操作: `pm2 stop|restart|logs akinavi-shadow`
- ログ: `C:\Users\admin\akinavi_shadow.log`（stdout/stderr とも）
- `caller.mjs` に Windows 対応を追加（claude が npm の .cmd シムのため
  `spawn(..., {shell: true})`、タイムアウト時は taskkill でツリーごと停止）。
  Mac/Linux の挙動は不変

## 運用メモ
- 停止: `systemctl --user stop akinavi-shadow`（nohup なら `pkill -f shadow_worker`、
  Windows/pm2 なら `pm2 stop akinavi-shadow`）
- 上限: 15件/サイクル・400件/日（`shadow_worker.mjs` 冒頭の定数）
- ログの `cost=$N` はAPI換算の参考値であり**実課金ではない**（サブスク枠）
- このワーカーと対話的な Claude Code 利用は同じMax枠を食い合う。上限に当たったら時間経過で回復する
