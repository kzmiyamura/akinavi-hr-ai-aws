# シャドーワーカー移設引き継ぎ書（Mac → ThinkCentre）

**この文書は ThinkCentre 上の Claude Code に読ませて実行させるための手順書。**
2026-08-07 作成。移設対象は LLM シャドーワーカー（`scripts/llm_extract/shadow_worker.mjs`）。
移設は完了済み。以降の未完了事項は次節を参照。

---

# 次回やること（2026-08-08 昼 時点）

## 現在の稼働状態（全て正常・push済み）
- ワーカー: pm2 `akinavi-shadow` が本番上書きモードで稼働中。
  本サイクル(5分・新規人材のLLM上書き) + 案件サイクル(5分・新規案件のLLM補正) +
  Box取込キュー(30秒・手動依頼＋全自動)の3本立て
- フロント: 「AI取込」ボタン（Boxワンクリック再解析）を main に push 済み → Vercel 自動デプロイ
- 答え合わせ: `node scripts/llm_extract/apply_report.mjs [日数|--id <id>]`

## ✅ 案件のLLM補正 実施済み（2026-08-08 夕・ユーザー依頼「入力画面の取り込みも人材レベルに」）
- UI「新規登録」やメール由来（現在は無効）で作られた**新規 prod 案件**をワーカーが後追い補正
- 方針は `project_apply.mjs`: **全項目 fill（既存値は触らない）** + required_skills は
  skill_master 照合の追加のみ + title はフォールバック「案件」のみ置換 +
  remote_policy はリモート関連語を含むときだけ受理（「派遣が必要」誤転記の実害ガード）
- 複数案件が1本文の行（raw_data.batchSize>1）は対応付け不能のためスキップ
- 既存 prod 案件8件へは 2026-08-08 に一括適用済み（8/8で補完・破壊ゼロ・
  `raw_data._regex_backup` に退避あり）。ドライラン: `node scripts/llm_extract/project_dryrun.mjs [N] [--apply]`
- 単体テスト: `node scripts/llm_extract/project_apply.test.mjs`（16ケース）
- **overwrite への昇格はドライラン実証が取れてから**（人材の FIELD_POLICY と同じ進め方）

## ✅ Box取込の全自動化 実施済み（2026-08-08 昼・ユーザー承認）
`box_status='pending'` かつ `resume_url` なし（prod・created_at < watermark）を
ボタン不要で自動処理する。1ポーリング2人まで・手動依頼（fetch_requested）優先。
実装は `shadow_worker.mjs` の boxQueue / processBoxCandidate を参照。

初回バックログ10人の実績（2026-08-08 昼に完走・夕方に全員解決）:
- 8人成功（YE/TS/HH/T.N/TA/DS/TK + 手動先行のH,I。docx/PDF/xlsx 全経路OK）
- AT/AH: 大型PDFで sonnet timeout → 下記項目4の二段対応後に再処理して両者とも解決
  （AH=sonnet完走30案件 / AT=haikuフォールバック19案件・needs_review）
- NK: Box共有リンクが404 → `failed`（UIの「AI取込 再試行」で人が再依頼可能。リンク自体が
  死んでいるので営業に新リンクをもらうしかない）

## ⚠️ 未解決: ROSTER誤分類被害11人の経歴書復旧（ユーザーの再転送待ち）
2026-08-08 昼まで の ROSTER誤分類（修正済み）で、Brightstar 経歴書11人分が本人に
紐付かなかった。メール原本はサーバーから完全削除済み（8/4以降 削除済みフォルダにも
残らない・原因はメールボックス側設定と推定）で自動復旧不可。
**ユーザーに転送元Outlookからの6通再転送を依頼済み**。再転送されれば修正済み
パイプラインが自動で処理する（dedup UPDATE なので重複しない）。対象件名は
このリポジトリの会話ログ or info1@brightstar.co.jp の 8/8 11:00-11:20 受信分

## ⚠️ 2026-08-08 昼に発見・修正した Box取込の重大バグ（教訓）
旧実装は inbound-email に**合成本文**（`Box経歴書ファイル取込: <ファイル名>`・件名`【Box経歴書】名前`）を
送っていたため、(1) regex が「Box経歴書」を会社名として抽出して from_company を破壊、
(2) inbound-email の dedup UPDATE が `desired_rate` を null で潰し `raw_profile` ごと差し替え
（元メール本文・_llm_applied・age・availableFrom 等が消失）していた。
実害は H,I の1名のみで、llm_shadow の body_fields から復元済み（元メール本文のみ復元不可）。

対策（実装済み）:
1. **元メール本文・元件名を送る**（UI再解析ボタンと同じ流儀）。元本文が無い場合のみ
   合成本文＋ from_company / desired_rate の退避・復元
2. **二重処理ガード**: 再解析は created_at を now にリセットするため（7日延命の仕様）、
   本サイクルが処理済み候補者を「新規」と誤認して LLM を二重に回していた。
   `_llm_applied.at >= created_at` ならスキップするガードを cycle() に追加
3. **複数人メール由来はスキップ**: target_candidate_id は block[0] に強制適用される仕様のため、
   全文再送で別人のデータが混ざる。同一 from+件名 の兄弟レコードがいたら failed にする。
   **なお UI の手動「再解析」ボタンにも同じ混線リスクが残っている（未対応・要検討）**

# やり残し（2026-08-08 朝 時点）

## ✅ 実地検証 完了（2026-08-08 午前・新規3名で確認）

初回の本番上書き3件（TK / OG / NH）をログとDBで確認した。**破壊的な上書きなし・停止不要**。

- **TK / OG**: 本文由来の fill のみ（空欄→単価・会社名・稼働時期等）。意図通り
- **NH**: フル機能ケース。経歴書27案件を sonnet 昇格で抽出し、projects /
  experience_years(空→23) / skillYears(44語→71語) / skills(+44) を上書き
- **NH の実ファイル答え合わせ**で regex の重大な誤りを AI が修正していたことを確認:
  スキルシートの行 `Java | Mac 27年 | Oracle Database(年数空欄)` で、regex は
  **Mac の27年を Oracle に誤帰属**（Oracle:324ヶ月）。AI は案件履歴から Oracle=2ヶ月と算出
- **AI 側の課題も1件発見**: 案件表の表記 `Js` を `JavaScript` に正規化せず別キーで
  記録するため、skillYears が `Js`（実年数）と `JavaScript:2` に分裂する。
  skillYears のキー正規化（normTech / skill_master alias 経由）は今後の検討課題
- **AI は資格シートの自己申告年数（例: JavaScript 23年）を使わず案件表から計算する**。
  自己申告 vs 実案件のどちらを正とするかは思想の問題（自己申告は往々にして過大）
- 答え合わせコマンド: `node scripts/llm_extract/apply_report.mjs [日数|--id <id>]`

**問題があれば即停止**（データは `_regex_backup` から戻せる）:
```bash
pm2 stop akinavi-shadow
# または記録のみモードで継続: SHADOW_APPLY=0 を入れて pm2 restart akinavi-shadow --update-env
```

補足（2026-08-08 に判明・対応済み）:
- 本文のみ由来の上書きで `_llm_applied.model` が null になっていた → `shadow_worker.mjs` で
  `bodyFields._model` を渡すよう修正済み（初回3件の TK/OG は model 欄が空のまま）
- `.docx` の経歴書は添付抽出の対象外（OG が該当）。xlsx のみ対応は従来仕様

## ✅ 追加機能（2026-08-08 実装・実地検証済み）

1. **docx/PDF 経歴書の LLM 抽出対応**（直近1000件の28%が未対応だった）
   `textract.mjs`（mammoth / pdfjs-dist）でテキスト化 → 疑似グリッドで既存の機械検証を共用。
   OG(docx・コンサル系6案件) / Y.K(pdf) の実ファイルで検証済み。旧 .doc(0.8%) のみ未対応
2. **Box経歴書ワンクリック再解析**
   UI の「AI取込」ボタン → `box_status='fetch_requested'` → ワーカーが30秒間隔で検知 →
   Box共有リンクからDL（`box_fetch.mjs`・認証不要スクレイプ）→ inbound-email へ添付投入
   （regex再解析・storage保存・resume_url付与）→ LLM再解析・上書き → `enriched`。
   H,I（元L2）で実地検証: 依頼から約2分で完了、経験年数9年はメール記載と一致。
   処理はサーバー側なのでタブ移動・リロードでも継続。失敗時は `failed` → ボタンで再試行可

## ⚠️ 2026-08-08 に発見・修正した重大バグ（教訓）

worker の SELECT に `desired_rate, from_company, experience_years, skills` が無く、
buildPatch が「既存値なし」と誤認 → fill 項目の上書き・skills 全置換が起きていた。
実害は NH / OG の skills 列のみで `candidate_skills` テーブルから復元済み。
**教訓: FIELD_POLICY / mergeSkills が参照する列と worker の select は必ず同期させる**
（初回3件の答え合わせで TK の再上書きに気づいて発覚。実地検証は複数サイクル見るべき）

## 未着手・要判断の項目

1. **答え合わせ用スクリプト → 作成済み**: `scripts/llm_extract/apply_report.mjs`。
   `raw_profile._regex_backup`（旧regex値）と現在値を突き合わせ、skillYears は
   消えた/追加/年数差、projects は件数・期間で要約表示する。`--json` で機械読み取り可

2. **滞留していた507件は意図的にスキップした**
   ユーザー指示「きりがいいから今からの新規人材から」に従い watermark を
   2026-08-07T02:16 → 現在時刻へジャンプさせた。この507件は AI 処理されないまま
   7日で archive される。遡及処理したい場合は watermark を戻す。

3. **Supabase への書き込みが1人2回になる問題**（ユーザーから提起・「後で対策」）
   - 案1: 変更が無ければ PATCH しない … **実装済み**
   - 案2: サイクル内の PATCH をまとめて1リクエストに（最大15人 → 1回）… 未着手
   - 案3: `llm_shadow` への記録をやめる（`_regex_backup` / `_llm_applied` で概ね代替可）… 未判断

4. **経歴書読み取りの180sタイムアウト**（シャドー運転時 1日約42件＝約12%）
   `callModel` に1回リトライを追加したが効果を測っていない。要経過観察。
   なお `claude.exe` 直叩きに変えた分は速くなっているはず（窓生成のオーバーヘッド解消）。
   → **2026-08-08 計測: ThinkCentre 移設後はタイムアウト0件 / 経歴書抽出148件**。ほぼ解消とみてよい
   → **例外: 超大型経歴書は今も落ちる** → **2026-08-08 夕方に二段対応済み**:
   1. `caller.mjs` タイムアウトをプロンプトサイズ連動に（10KB超は+1秒/200字・上限480秒）。
      AH(1.2MB PDF・30案件)はこれで完走
   2. `run.mjs` sonnet昇格が失敗したら haiku の部分結果を needs_review で採用。
      AT(33案件PDF)は sonnet が480秒でも落ちるため haiku の19案件を採用して復旧。
      完全な33案件が要るなら分割抽出（前半/後半）が次の手（未実装）

5. **`experience_years` の上書きが妥当かは未検証**
   ドライランで13件が変化（7→10 / 1→2 / 5→6 / 17→16 等）。案件期間の暦unionで
   算出しており理屈は通っているが、**どちらが正しいかの裏取りをしていない**。
   `HANDOFF_EXCEL_VERIFICATION.md` の保留事項（IS/IT/KK の3名で自己PR記載の
   前職経験が合算されない問題）は、この暦union方式で自然解決する可能性がある。
   答え合わせの際に併せて確認するとよい。

6. **日次上限400件に張り付いていた**
   実流量は約250〜300人/日。移設直後は過去分の消化で上限に到達していた。
   定常運用でも上限に当たるようなら `shadow_worker.mjs` 冒頭の `MAX_PER_DAY` を要調整。

7. **`skills` 列は現状「追加のみ」**
   skill_master 照合済みで既にきれいなため全置換していない（`apply.mjs` の
   `SKILLS_REPLACE = false`）。AI の techs を skill_master 経由で正規化して
   完全移行するかは未判断。

## この作業で分かった重要な事実（判断の前提）

- **regex は「取りこぼす」だけでなく「ゴミを混ぜる」**。候補者KYの実ファイル照合で、
  regex が `※項番4` `5同時稼働` `会議体の調整：7名` 等を技術名として登録していたことを確認
- **ただし AI も万能ではない**。氏名に年齢・駅を巻き込む（`KM` → `KM29蕨`）、
  単価の範囲下限を落とす（`61～65万円` → `65万円`）等の劣化が実データで出た。
  「AI で全部上書き」は成立せず、項目ごとの方針分けが必須（`FIELD_POLICY`）
- **費用ゼロ制約のため AI は Edge Function 内では回せない**（Max枠は CLI 専用）。
  したがって「regex が先に登録 → この PC の AI が後から直す」構造は今後も変わらない

---

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
