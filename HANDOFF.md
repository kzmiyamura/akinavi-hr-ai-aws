# 引き継ぎ（2026-08-12 夜時点）

## 0. 次セッションの最初にやること

### ⓪ 日付書式付きの数値セルがスキル表を壊す → **対応済み（2026-08-12 夜）**

本番は `XLSX.read(bytes, { cellDates:true })` で読む（`index.ts:7299`）ため、
「期間」列に日数を入れて `"00年9ヶ月"` と表示する書式のファイルでは、その数値が
Date に化けて 1900〜1902年の日付になる。`cellToText` が y>=1900 を日付として通していたので
`"1900/9/9"` と出力され、期間列が壊れてスキル表の抽出が丸ごと失敗していた。

セルの表示文字列（`w`）は `"00年9ヶ月"` と正しいので、1910年より前はそちらに任せるよう修正。
`w` が無いときだけ従来どおり日付にする（後方互換）。

- 実害だった T.A（`2b2234fb`）: 再解析で **skillYears 0件 → 50件**
- テストは先に足した（`test_excel_anomalies.mjs` の S1〜S8。修正前は S1/S2/S6 が FAIL）
- 影響範囲は小さい。`node scripts/audit_date_formatted_cells_sweep.mjs --with-skills --limit 50`
  で50件中1件（= T.A）のみ。既存人材の一括再解析は不要
- 調査ツール `scripts/inspect_date_formatted_cells.mjs` を追加（化けたセルの元の数値・
  書式・列の見出しを出す）

**教訓**: 調査ツールと本番で Excel の読み込みオプションが違うと、存在しない差異を
追いかけることになる。`probe_skillyears` / `audit_replay_experience_impact` /
`debug_excel_spans` は本番に合わせて修正済み。`test_excel_parsing.mjs` は元から正しい。

### 既知の失敗: M.S が 546（WORKER_RESOURCE_LIMIT）で再解析できない

`2d131015-d64e-4457-98db-54dedb06ce7b`。3回試して3回とも 546。**変更前から失敗している**。

- 入力サイズ起因ではない: 本文1,116文字（prod中央値1,483より小さい）、
  シートは13〜14行・37〜42セル。`scripts/sql/audit_candidate_payload_size.sql` で確認
- ファイル自体は 275KB。シートが小さいのにこのサイズ＝書式・図形が重いとみられる
- ログ上は `[Excel-parse]` まで進んでから落ちる。`tryVisualSkillExtraction`
  （罫線・色のために生バイトを読む）が怪しい
- ローカルでは2枚目「スキルシート（修正版）」から12スキル取れる

### ① スキル一致判定が緩すぎる → **対応済み（2026-08-12 夜）**

`20260812_skill_match_normalize.sql` で部分一致をやめた。詳細はコミット `264be99`。
判定は「正規化（skill_master の別名）＋包含関係＋語境界」の3つ。

- 実体 `skill_hit_weights()` / 定義 `skill_satisfies()`。判定を変えたら
  `scripts/sql/test_skill_matching.sql`（28ケース）と
  `test_skill_matching_rpc_parity.sql`（定義と実体を実データで突き合わせ）を実行する
- `auto-match` の JS 側フィルタとマッチング画面の緑表示も同じ判定に載せ替えた
- 営業判断: MySQL 等の製品名だけの人も SQL 要件を満たす（`skill_implications`）。
  Spring だけの人は Spring Boot 要件を満たさない
- 効果: PowerShell案件の上位20名で「Shellだけの人」が15名→1名。
  必須スキルごとの充足人数は `scripts/sql/audit_skill_requirement_coverage.sql` で見られる

**残っている関連の課題**: 「テスト」「基本設計」は表記が完全一致するので今回の変更では減らず、
今も全人材の7割強が満たす（テスト1,486人・基本設計1,141人）。重み1に落としてあるので
配点上の影響は小さいが、**必須スキルとして扱う価値がほぼない**。案件登録時に工程語を
必須スキルから外すか、重み0にするかは未判断。

### ② 人材の skillYears 一括再解析（中断したまま・**次の最優先**）

`bulk_replay_missing_skillyears.mjs` は 225件が対象。15件だけ実行して**停止した**。

停止理由だった「経験年数が下振れする」は **測って解消した（2026-08-12 夜）**。

`node scripts/audit_replay_experience_impact.mjs 365 --all` で、DBを変えずに
再解析後の値を先に測れる。Excel対象41件での実測:

| 経験年数 | 件数 |
|---|---|
| 変化なし | 18 |
| 上振れ | 9 |
| 下振れ | 7（うち**5件は今の値が「年齢−22」と一致**＝当てずっぽうが実測値に変わるだけ） |
| 判定不能 | 4 |
| 新規に付く | 3 |

**本文由来の経験年数は下がらない**。本番は Excel 由来の値が今の値より大きいときしか
上書きしない（`index.ts:10404`）。下振れするのは本文に記載が無く年齢推定だった人だけ。

**この過程で見つけた本番バグ2件（修正・デプロイ済み）**

1. **先頭シートがスパンだけのとき、後続シートの実スキル表を読まなかった**
   （`index.ts:7371`）。続行条件が「skillYears が空」で、スキルが取れなかったシートには
   フォールバックが `_dateSpanMonths` を付けるため、そこで打ち切られていた。
   実例 H.I: 表紙の「職務経歴書」で打ち切り、27スキルある「実績一覧」を読まず。
   修正後の再解析で **0件→37スキル**（経験年数は24年のまま）
2. **`probe_skillyears.mjs` が本番と違う入力を渡していた**。「ローカルでは
   `_dateSpanMonths` が出るのに Edge Function では付かない」という前セッションの
   未解決事項は、ツール側の不具合だった（`sheet_to_json` を渡していた／
   `worksheetToCells` の戻り値の形が違った）。本番と同じ経路に直してある

なお **DB に `_dateSpanMonths` が入らないのは仕様**。`index.ts:10597` で表示用
skillYears から内部キーを除外して保存している。経験年数の推定は保存前に済ませている。

**残っている実態**: 再解析対象241件のうち **152件はPDF**。skillYears が取れるのは実質
Excel だけなので、`--excel` を付けて回す（付けないと大半が無駄打ちになる）。
PDF の skillYears 取得率は38%（93/245）で、Excel の95%（897/940）に比べて低い。
**PDFからのスキル抽出が次の伸びしろ**。

**Excel対象は流し終えた（2026-08-12 夜）**。11人で skillYears が回復し、
xlsx の未取得は **43件 → 27件**（取得済み 897 → 911）。
内訳: T.A 50件 / TA 62件 / H.I 37件 / HT 29件 / M.T 28件 / TK 28件 / I.Y 19件 /
W.Y 17件 / M.Y 15件 / YN 5件 / A.T 2件。
残る27件は経歴書にスキル表が無く、再解析しても変わらない（日付スパンだけ読める）。
失敗は M.S の1件のみ（下記）。

---

## 1. 今日（8/12 午後〜夕方）やったこと

### 案件側をマッチングに使える形にした（ユーザーの主目的）

前提: **案件メールの自動取り込みは使わない方針**（`inbound_project_enabled` は未設定＝無効）。
prod の案件は **手動登録の8件のみ**（5/25〜6/17 登録、以降ゼロ）。
手動登録は `inbound-email` に `force:true` で投げるので、抽出器を直せばそのまま効く。

**穴だった2点を修正**

1. **勤務地の非対称**: 人材側は station_master で都道府県に正規化されるのに、案件側は
   `work_location` が生文字列のまま。RPC は `(\S+?)[都道府県]` で切るため
   「東品川（最寄りは青物横丁または品川シーサイド）」型は都道府県が取れず、
   **勤務地の重み20が丸ごと0点**だった
   → `projects.work_prefecture` を追加。駅名を station_data.json に照合して解決
2. **経験年数が片側採点**: 案件に必要経験年数の受け皿が無く「10年以上=満点」の絶対評価
   → `projects.required_experience_years` を追加。「N年以上/程度/前後」を抽出

検証（`scripts/sql/verify_project_prefecture_scoring.sql`）: 「東品川」案件の上位8件が
長野・愛知・千葉が混ざる並びから東京都中心に変わった。

**必須スキルの重み付け**（`skill_weights` jsonb）

工程語だけ一致した候補者が上位に来る問題への対応。
`skill_master.category` で傾斜（languages=4 … methodologies/others=1）、
年数指定あり +2、記載順の先頭 +1、上限6。例: `Java×6 / Spring Boot×3 / 保守開発×2 / テスト×1`。
配点は「一致した重みの合計 ÷ 全体の重み合計」。NULL なら従来どおり等価。

**ただし現状ほとんど順位が動かない**（理由は上記①）。

**画面**（`ProjectPage.tsx`）
- 詳細の先頭に要約カード（`RecruitSummary`）: 「役割 を N名 / 求める人 / 条件」
- 「マッチングに使う条件」パネル（`MatchingInputs`）: 配点の軸ごとに取れた値と、
  取れないと何が起きるかを表示。未取得は赤字。スキルの重みも一覧表示
- **単価が消えるバグを修正**: 表示条件が `budget_min` だけを見ていたため、
  「〜80万円」のように上限しか書かれていない案件（8件中ほとんど）で単価が出ていなかった
- 詳細ペインでタイトルが二重に出ていたのを解消

### 案件のLLM補正（既存の仕組みだった）

`shadow_worker.mjs:446` の `projectCycle` が既に案件をLLM補正している（2026-08-08 実装）。
既存8件に効いていなかったのは `projWatermark` が**初回起動時刻で初期化**され、
それ以降の登録しか見ないため。`project_dryrun.mjs` で遡って適用できる。

適用した結果、**LLMが余計なものを足す問題**が判明したのでガードを入れた。

- `required_skills` を「追加のみ」→ **regexが0件のときだけ fill** に変更。
  実測で役に立ったのは required_skills が空だった1件だけで、既存への追加は全部ノイズ
  （`Azure Functions` があるのに `AzureFunction`、`Microsoft 365` があるのに `M365`）。
  必須スキルが増えると分母が膨らみ、同じ候補者でもスコアが下がる
- `role_summary` から体制語（メンバー・要員・担当者等）を除外。
  「PLとメンバーの合計3名」から `roleSummary="メンバー"` を拾い、見出しが
  「メンバー を 1名」になっていた
- 既に入った重複は `project_dedupe_skills.mjs` で掃除済み（4件）

ガード後に再度8件へ流してノイズ提案ゼロを確認。

### 解析経路の整理（ユーザー質問への回答）

| 対象 | 何で解析しているか |
|---|---|
| 案件（取り込み） | **ルールベースのみ**。`inbound-email` の正規表現＋`skill_master`照合＋`station_master` |
| 案件（補正） | ThinkCentre の pm2 ワーカーが `claude -p --model claude-haiku-4-5` |
| 人材（取り込み） | 同じくルールベース |
| 人材（補正） | 同上のワーカー。1日100件・直近3日・Java/C#絞込 |
| マッチング採点 | Cerebras `llama3.1-8b` → Groq `llama-3.3-70b` → Gemini `2.5-flash` の3段 |

`caller.mjs:82` が Claude Code CLI をヘッドレスで spawn している
（`ANTHROPIC_API_KEY` があればAPI直に切替。既定はサブスク枠）。

### motion-lab 型のAPI口について（ユーザー質問への回答）

作れる。`motion-lab/server/tunnel-wrapper.mjs` が実装例で、ローカルHTTPサーバ（:4000）を
cloudflared Quick Tunnel で公開し、変わるURLを共有シークレット付きで報告、
ヘルスチェックで死んだトンネルを張り直す構成。akinavi なら報告先を `app_config` にすれば
新規インフラ不要。

**ただし今の用途では不要**。ポーリング方式で足りている。即時解析（登録ボタンを押した
瞬間にAI解析して返す）が欲しくなったら作る。その場合はシークレット必須。

---

## 2. 追加・変更したもの一覧

**DBマイグレーション（適用済み）**
- `20260812_project_matching_prefecture_and_exp.sql` — `work_prefecture` / `required_experience_years` 追加、RPC に `p_work_prefecture` / `p_required_exp_years`
- `20260812_project_skill_weights.sql` — `skill_weights` 追加、RPC に `p_skill_weights`、一致判定を必須スキル側の充足に変更

**新規スクリプト**
- `scripts/audit_project_matching_fields.mjs` — 案件側の項目充足率をマッチング観点で測る
- `scripts/backfill_project_matching_fields.mjs` — 既存案件に県・要求年数・重みを遡り補完
- `scripts/probe_skillyears.mjs` — 1人の経歴書を各抽出方式に通して比較（`_dateSpanMonths` の有無確認用）
- `scripts/llm_extract/project_dedupe_skills.mjs` — 必須スキルの表記ゆれ重複を掃除
- `scripts/sql/verify_project_prefecture_scoring.sql` / `verify_project_skill_weights.sql`

**直したスクリプト**
- `bulk_replay_missing_skillyears.mjs` — `--limit` の値を対象日数と誤認するバグ、`--id` 追加
- `debug_excel_spans.mjs` — CRLF の `.env.local` を読めない（実害）、`--rows` / `--cols` 追加
- `project_dryrun.mjs` — `source` 前提をやめ env を自前で読む

---

## 3. 監視ポイント（前セッションから継続）

- 名簿行上限 70 化の副作用: 546（CPU限界）タイムアウトや幽霊増がないか
- C-ROSTER-CAP / C-ROW-LINK-SKIP / D-UNASSIGNED が減ったか
  （`npx supabase db query --linked -f scripts/sql/audit_roster_drops.sql`）
- 隔離済み89件の完全削除（`node scripts/audit_quarantined.mjs 7 --delete`）は**ユーザー判断待ち**
- ワーカー処理能力: 絞込合致の流入 ≒105件/日 vs 上限100件/日で拮抗。
  上限引き上げは Max 枠消費と引き換えのため**ユーザー判断待ち**
- egress: 8/11 は PostgREST 86.5MB（8/10 の366MBから76%減）。無料枠 5GB/月 ＝ 約166MB/日

---

## 4. 積み残し

- **PDFからのスキル抽出**（skillYears 取得率38% / Excel は95%）。人材の152件が
  PDF経歴書で skillYears 空のまま。再解析しても取れないので抽出器側の対応が要る
- **工程語が必須スキルとして機能していない**: 「テスト」は1,486人・「基本設計」は1,141人が
  満たす（全人材の7割強）。表記が完全一致するのでスキル一致判定の厳格化では減らない。
  重み1に落としてはあるが、案件登録時に必須スキルから外すか重み0にするかは未判断
- 案件の重複表示: 同じ案件の再送（条件更新版）が2件並ぶ。古い方を閉じる仕組みがない
- 尚可スキルは抽出済みだがスコアに未加算
- 面談回数・「※延長可能性あり」は保存する項目自体がない
- `work_prefecture` / `required_experience_years` は `PROJECT_FIELD_POLICY` に入っておらず
  LLM側は埋めない。AIにも担当させるなら追加が要る
- 氏名が壊れている人材が混ざっている（「オープン系」「業務アプリケーション開発を中心に…」等）。
  `node scripts/audit_bad_names.mjs` で確認できる

---

## 5. ワーカーの現在の設定

| 項目 | 値 | 変え方 |
|---|---|---|
| モデル | **Haiku 単独**（Sonnet 廃止） | `SHADOW_USE_SONNET=1` で復活 |
| 日次上限 | **100件/日** | `SHADOW_MAX_PER_DAY` |
| 対象期間 | **直近3日** | `SHADOW_LOOKBACK_DAYS` |
| 取得順 | 新しい順（キュー方式） | — |
| スキル絞込 | **Java, C#** | 設定画面 or `set_filter_skills.mjs` |

env を変えて再起動する場合は `pm2 restart akinavi-shadow --update-env`。

### 消費量の報告は必ずトークンで

**ドルで言わないこと。** Max サブスク枠なので `llm_shadow.cost_usd` は API換算の参考値であって
実際の支払額ではない。`node scripts/llm_extract/usage_split.mjs 3` で用途別トークンを見る。

---

## 6. よく使う確認コマンド

```powershell
pm2 list                                        # akinavi-shadow が online か
node scripts/audit_recent_quality.mjs 10        # 直近10件の読み取り品質
node scripts/audit_skillyears_gap.mjs 7         # スキル年数が取れない原因の内訳
node scripts/audit_project_matching_fields.mjs 365 --all   # 案件側の充足率
node scripts/probe_skillyears.mjs <candidate_id>           # 抽出方式ごとの比較
node scripts/test_excel_anomalies.mjs           # 合成異常系195ケース
node scripts/test_excel_parsing.mjs --compact   # Excel回帰（10件）
node scripts/llm_extract/sb-query.mjs "candidates?select=id,name&limit=5"
```

**注意**: `scripts/testData/excel/` は PII のため git 管理外。空だと回帰が Total 0 で
空回りする（合格に見える）。空なら `node scripts/download_failing_excels.mjs` で再取得。

## 7. egress を無駄遣いしないための鉄則

- **`raw_profile` を丸ごと select しない**（1件約35KB）。
  JSON パスで必要な項目だけ取る: `select=id,sy:raw_profile->skillYears`
- 件数は `select=count` で数える。レコードを取って数えない
- `sb-query.mjs` は既定で最大1000件返す。`limit` を必ず付ける

## 8. セッションを切る目安

作業セッション側の消費はワーカーより大きい（8/10 実測でキャッシュ読み687M）。
会話が伸びるほど毎ターン読み直す文脈が増える。**切るなら作業単位の完了時**。
調査の途中で切ると同じファイル読み直しが発生して逆効果。
