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

## 本番上書きモードへ移行（2026-08-07・ユーザー判断）

シャドー記録のみだった運用を「新規登録人材の candidates を AI で上書きする」に変更した。
過去データには遡及しない（ユーザー指示「きりがいいから今からの新規人材からやってみよう」）。

- 実装: `apply.mjs`（`FIELD_POLICY` で項目ごとに overwrite / fill を指定）
- **既定は fill（安全側）**。`'overwrite'` と明記した項目だけが既存値を置き換える
- 上書き前の regex 値は `raw_profile._regex_backup` に退避。適用情報は `raw_profile._llm_applied`
- 記録のみに戻す: `SHADOW_APPLY=0` を環境変数に入れて `pm2 restart akinavi-shadow --update-env`

### なぜ「全上書き」にしなかったか（実データ60件のドライラン結果）
全項目を無条件に AI で置き換えると以下が劣化することが判明したため、項目ごとに分けた。

| 項目 | 方針 | 根拠 |
|---|---|---|
| name | overwrite | regex が「年　数」「項番」「Frame」を氏名として登録していた。ただし AI 側も「KM」→「KM29蕨」と年齢・駅を巻き込む例があり、数字を含む名前は `isUsableName` で棄却 |
| from_company | overwrite | regex「Visual StudioCo」→ AI「株式会社ai・more」 |
| age / gender | overwrite | 主に空欄の補完。gender は「男」「男性」を同一視して無駄な更新を回避 |
| experience_years | overwrite | 案件期間の暦 union から算出。重複期間の二重計上を排除 |
| skillYears / projects | overwrite | regex は「※項番4」「5同時稼働」「会議体の調整：7名」等を技術名として登録していた（KY で実証） |
| desired_rate | **fill のみ** | AI が「61～65万円」→「65万円」と範囲の下限を落とす |
| nearestStation | **fill のみ** | AI が「月～都営大江戸線　西新宿五丁目駅」等のゴミを混ぜる。駅名→都道府県の逆引きにも影響 |
| employmentType | **fill のみ** | AI「1社先個人事業主」は商流と雇用形態の混在。商流は `raw_profile.commercialFlow` が別に保持しており、かつ `MatchingPage` が `employmentType === '派遣社員'` の完全一致で派遣許可チェックを分岐するため壊せない |
| skills | 追加のみ | skill_master 照合済みで既にきれい。全置換すると営業が意図的に含めた工程スキル（テスト/要件定義/保守運用）が消える |

### 未対応（次回検討・ユーザーから提起）
- **Supabase への書き込みが1人あたり2回になる**（regex が登録 → AI が更新）。対策候補:
  1. 変更が無ければ PATCH を投げない … **実装済み**
  2. サイクル内の PATCH をまとめて1リクエストにする（最大15人 → 1回）
  3. `llm_shadow` への記録をやめる … `raw_profile._regex_backup` / `_llm_applied` に
     同等情報が入るようになったため、答え合わせ目的では概ね代替可能。監視用の
     model / status / reasons / cost をどこまで残すか要判断
- 経歴書読み取りの 180s タイムアウト（1日約42件）。1回リトライを入れたが要経過観察
- 過去データへの遡及適用は未実施

## 運用メモ
- 停止: `systemctl --user stop akinavi-shadow`（nohup なら `pkill -f shadow_worker`、
  Windows/pm2 なら `pm2 stop akinavi-shadow`）
- 上限: 15件/サイクル・400件/日（`shadow_worker.mjs` 冒頭の定数）
- ログの `cost=$N` はAPI換算の参考値であり**実課金ではない**（サブスク枠）
- このワーカーと対話的な Claude Code 利用は同じMax枠を食い合う。上限に当たったら時間経過で回復する
