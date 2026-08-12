# 引き継ぎ（2026-08-13 時点）

前回セッションのコミット範囲: `62b33c3..2ab235c`（13コミット）。全て push 済み。

---

## 0. 次にやること

### ★ スキル緑表示の件: ほぼ白と判明（残るは目視1回だけ）

8/13 に切り分けを実施した。**原因は「観察時点の Vercel デプロイが古かった」でほぼ確定。**

調べた事実:

1. **現在の Vercel は最新コード**。デプロイ済みバンドル `assets/index-D-YZVJrc.js` に
   `match_skill_strings` が含まれ、ローカル `npm run build` の成果物と
   **ファイル名ハッシュが完全一致**（＝HEAD のビルドが配信されている）
2. **サーバ判定は正しい**。M.K の実スキルで RPC を直接呼んだ:
   `match_skill_strings({C, Objective-C, .NET Framework, MySQL}, {C#, Java, SQL, VB.net})`
   → 返るのは `MySQL→SQL` の1組だけ。**C は C# を満たさない**
3. **テスト全て PASS**: test_skill_matching.sql 28/28、
   test_skill_matching_rpc_parity.sql（1,571人・食い違い0）、
   test_match_skill_strings.sql、vitest skillMatch 7/7、`npm run build` 成功
4. **フロント配線も正常**（`MatchingPage.tsx:1384` で `projectSkillMatcher` を
   RPC から取得し `:1896` で渡している。`NO_MATCHES` は読込中フォールバックのみ）
5. **観察された表示は旧コードの挙動と完全一致**。観察対象はスコア順2位の
   M.K（`938cfb4a`、C# なし・C あり・Java/JavaScript なし）とみられ、
   旧ルール（双方向部分一致）だと `"C#".includes("C")` で C も C# も緑、
   Java・基本設計・VB.net は取り消し線 — 見た目がそのまま再現する。
   なお RPC の順位では精密機器案件の1位は K.N。submissions のスコア順では
   1位 K.M（70点・本物の C# 持ち）、2位 M.K（67点）
6. 案件「１．精密機器製造・販売会社向け…」は **prod に2件重複**
   （`82da71a0`=C#/VB.net 表記、`b49f11d9`=C#.NET/VB.NET 表記）。既知の積み残し

残作業（5分）: ブラウザで当該案件を開き、M.K の必須スキルパネルで
**C# が取り消し線・SQL とテストだけ緑**になっていることを目視する。
8/13 にブラウザで開く直前まで進めて中断した。スーパーリロード
（キャッシュに旧バンドルが残っている可能性）を忘れずに。

### 次点: PDF からのスキル抽出

skillYears の取得率が **PDF 38%（94/246）** に対し **Excel 95%（911/938）**。
prod 人材の **152件**が PDF 経歴書で skillYears 空のまま。再解析しても取れないので
抽出器側の対応が要る。人数が一番大きい伸びしろ。

### 既知の失敗: M.S が 546（WORKER_RESOURCE_LIMIT）で再解析できない

`2d131015-d64e-4457-98db-54dedb06ce7b`。3回試して3回とも 546。**変更前から失敗している**。

- 入力サイズ起因ではない: 本文1,116文字（prod中央値1,483より小さい）、
  シートは13〜14行・37〜42セル。`scripts/sql/audit_candidate_payload_size.sql` で確認
- ファイル自体は 275KB。シートが小さいのにこのサイズ＝書式・図形が重いとみられる
- ログ上は `[Excel-parse]` まで進んでから落ちる。`tryVisualSkillExtraction`
  （罫線・色のために生バイトを読む）が怪しい
- ローカルでは2枚目「スキルシート（修正版）」から12スキル取れる

### 判断待ち（ユーザーに聞くこと）

- **工程語を必須スキルとして扱うか**。「テスト」は1,486人・「基本設計」は1,141人が
  満たす（全人材の7割強）。表記が完全一致するのでスキル判定の厳格化では減らない。
  重み1に落としてはあるが、案件登録時に必須スキルから外すか重み0にするか未判断
- 隔離済み89件の完全削除（`node scripts/audit_quarantined.mjs 7 --delete`）
- ワーカーの日次上限引き上げ（流入 ≒105件/日 vs 上限100件/日で拮抗。Max枠消費と引き換え）

---

## 1. 前セッション（8/12 夜〜8/13）でやったこと

### ① スキル一致判定の厳格化（引き継ぎの最優先だった項目）

`20260812_skill_match_normalize.sql`（コミット `264be99`）。

必須スキルの充足判定が双方向の部分一致だった。**逆方向**（`要件 LIKE '%候補者スキル%'`）が
特に有害で、prod 人材2,007件の実測でこうなっていた。

| 誤一致 | 人数 |
|---|---|
| `"C"` → Azure Functions / Microsoft 365 / C# | 399人 |
| `"Shell"` → PowerShell | 329人 |
| `"JavaScript"` → Java | 983人 |
| `"ROS"` → Microsoft 365（mic-**ROS**-oft） | 38人 |
| `"R"` → ほぼ全ての必須スキル | 5人 |

結果ほぼ全員が必須スキル満点近くになり、8/12 に入れた重み付け（`skill_weights`）が
順位を動かせなかった。**重み機構ではなくこちらが原因だった。**

新しい判定（いずれか1つを満たせば充足）:

1. **正規化した正式名が一致** — `skill_master` の別名で寄せる。空白除去・小文字化。
   解決できなければ末尾のバージョン番号を落として再試行（`Java8` → `Java`）。
   語幹2文字以上かつ既知スキルのときだけ（`S3` → `S` にはしない）
2. **包含関係**（`skill_implications` テーブル）— `MySQL` を持つ人は `SQL` 要件を満たす。
   **逆は成り立たない**（向きのある関係）
3. **必須スキルを語として含む** — 前後が英数字・`#`・`+` でない。
   `java` ⊄ `javascript` / `java` ⊂ `oracle java se` / `c#` ⊂ `c#.net`

必須スキルごとの充足人数の変化:

| 必須スキル | 変更前 | 変更後 |
|---|---|---|
| Azure Functions | 656 | 14 |
| Microsoft 365 | 592 | 201 |
| PowerShell | 457 | 195 |
| Java | 1,232 | 984 |
| C# | 702 | 463 |
| Spring Boot | 430 | 213 |
| SQL | 1,473 | **1,566**（②で製品名だけの人を救うので増える） |
| EntraID | 5 | **37**（`Entra ID` の空白を吸収するので増える） |

PowerShell案件の上位20名で「Shellだけの人」が **15名→1名**。

**営業判断（ユーザー確認済み）**
- MySQL/PostgreSQL/Oracle 等の製品名しか書いていない人も **SQL 要件を満たす**
  （「SQLマスターみたいなイメージ」＝製品名で書く人を落としたくない）
- **Spring だけの人は Spring Boot 要件を満たさない**（包含関係を作らない）

**判定を1か所に集約した**。同じ判定が散らないよう次の構成にしてある。

| 用途 | 呼ぶもの |
|---|---|
| 判定の定義（読める形・テストの期待値） | `skill_satisfies(have, want)` |
| 判定の実体（集合演算・性能重視） | `skill_hit_weights(data_env, skills, weights)` |
| マッチングRPC | `fetch_candidates_for_project` → `skill_hit_weights` |
| auto-match の事前フィルタ | `supabase.rpc('skill_hit_weights')` |
| マッチング画面の緑表示 | `match_skill_strings(have[], want[])` → `src/lib/db/skillMatch.ts` |

**判定を変えたら必ず回すテスト**
```
npx supabase db query --linked -f scripts/sql/test_skill_matching.sql            # 28ケース
npx supabase db query --linked -f scripts/sql/test_skill_matching_rpc_parity.sql # 定義と実体の突き合わせ
npx supabase db query --linked -f scripts/sql/test_match_skill_strings.sql       # 画面用RPC
npx vitest run src/lib/db/__tests__/skillMatch.test.ts                           # 7ケース
```
parity テストは prod の実データで定義と実体を突き合わせる（候補者1,881件・食い違い0）。

**新しいDBオブジェクト**
- `skill_norm_map`（マテリアライズドビュー）— skill_master の正式名＋別名 → 正式名。
  `skill_master` 更新時にトリガで自動的に貼り直す
- `skill_implications`（テーブル）— 向きのある包含関係。RDBMS・DWH 29件を投入済み

### ② skillYears 一括再解析（前回中断していた項目）— 完走

停止理由だった「経験年数が下振れする」は **測って解消した**。
`node scripts/audit_replay_experience_impact.mjs 365 --all` で DB を変えずに先に測れる。

Excel対象41件の実測: 変化なし18 / 上振れ9 / 下振れ7 / 判定不能4 / 新規3。
下振れ7件のうち**5件は今の値が「年齢−22」と一致**＝当てずっぽうが実測値に変わるだけ。

**本文由来の経験年数は下がらない**。本番は Excel 由来の値が今の値より大きいときしか
上書きしない（`index.ts:10404`）。下振れするのは本文に記載が無く年齢推定だった人だけ。

**Excel対象を流し終えた。11人で skillYears が回復**し、xlsx の未取得は **43件 → 27件**
（取得済み 897 → 911）。内訳: TA 62 / T.A 50 / H.I 37 / HT 29 / M.T 28 / TK 28 /
I.Y 19 / W.Y 17 / M.Y 15 / YN 5 / A.T 2。
残る27件は経歴書にスキル表が無く、再解析しても変わらない（日付スパンだけ読める）。

### この過程で見つけた本番バグ3件（全て修正・デプロイ済み）

1. **先頭シートがスパンだけのとき、後続シートの実スキル表を読まなかった**（`86c177c`）
   `index.ts:7371` の続行条件が「skillYears が空」だった。スキルが取れなかったシートには
   フォールバックが `_dateSpanMonths` を付けるので、そこで打ち切られる。
   実例 H.I: 表紙の「職務経歴書」で打ち切り、27スキルある「実績一覧」を読まず。
   → 続行条件を「**実スキル**が1件も無いこと」に変更。再解析で 0件→37スキル。
   複数シートを見るようになるので添付全体に 4.5秒の予算を設けた（546対策）

2. **日付書式が付いた数値セルが期間列を壊していた**（`40c5156`）
   本番は `XLSX.read(bytes, { cellDates:true })`（`index.ts:7299`）。
   「期間」列に**日数**を入れて `"00年9ヶ月"` と表示する書式のファイルがあり、
   その数値（253日など）が Date に化けて1900〜1902年の日付になる。
   `cellToText` が `y>=1900` を日付として通すので `"1900/9/9"` と出力され、
   期間列が壊れてスキル表の抽出が丸ごと失敗していた。
   → セルの表示文字列（`w`）は `"00年9ヶ月"` と正しいので、**1910年より前はそちらに任せる**。
   `w` が無いときだけ従来どおり日付にする（後方互換）。
   実害だった T.A（`2b2234fb`）は再解析で **skillYears 0件 → 50件**。
   影響範囲は標本50件中1件だけ（`audit_date_formatted_cells_sweep.mjs` で確認）なので
   既存人材の一括再解析は不要

3. **本番ビルド（`tsc -b`）が 8/11 から壊れていた**（`f3d0f44`）
   `npx tsc --noEmit` は通るが `npm run build` は3件の型エラーで失敗していた。
   Vercel が使うのは後者。**この間デプロイが失敗していた可能性がある**（要確認・上記★）

### 調査ツールが本番と違う入力を渡していた（`00e7bfa` / `c18301c`）

前セッションの未解決事項「ローカルでは `_dateSpanMonths` が出るのに Edge Function では
付かない」は、**ツール側の不具合**だった。2つの食い違いがあった。

- `probe_skillyears` が `sheet_to_json` の出力を Unified に渡していた（本番は `worksheetToGrid`）。
  さらに `worksheetToCells` の戻り値の形が違い（`{rowSpan,colSpan}` vs `{rowEnd,colEnd}`）、
  cells 系の抽出が常に空を返していた
- 読み込みオプションが `cellDates` なしだった（本番は `true`）

`probe_skillyears` / `audit_replay_experience_impact` / `debug_excel_spans` は修正済み。
`test_excel_parsing.mjs` は元から正しい（`cellDates:true`）。

**教訓: 調査ツールと本番で入力の作り方が違うと、存在しない差異を追いかけることになる。**
Excel 系のツールを新しく書くときは `worksheetToGrid` / `worksheetToCells` と
`{ cellDates: true }` を使うこと。

### DB に `_dateSpanMonths` が入らないのは仕様

`index.ts:10597` で表示用 skillYears から `_totalProjectMonths` / `_dateSpanMonths` を
除外して保存している。経験年数の推定は保存前に済ませてある。
**DB を見て「取れていない」と判断しないこと。**

### その他

- `.qc_bodies/`（経歴書本文＝PII）と `qc_dump.mjs` を削除（ユーザー承認済み）
- `bulk_replay_missing_skillyears.mjs` の修正（`424869b`）
  - `365 --run --excel` が7日として動いていた（`--limit` が無いと `limitAt=-1` になり
    `limitAt+1=0` で先頭の数値引数を弾いていた）
  - 連続実行で `TypeError: fetch failed` が散発（39件中17件）→ 1.5秒ずつ2回まで再試行
  - `--excel` を追加。対象241件のうち152件はPDFで、付けないと大半が無駄打ちになる

---

## 2. 前々セッション（8/12 午後）の内容

### 案件側をマッチングに使える形にした

前提: **案件メールの自動取り込みは使わない方針**（`inbound_project_enabled` は未設定＝無効）。
prod の案件は **手動登録の8件のみ**。手動登録は `inbound-email` に `force:true` で投げるので、
抽出器を直せばそのまま効く。

- **勤務地の非対称を解消**: `projects.work_prefecture` を追加。人材側は station_master で
  都道府県に正規化されるのに案件側は生文字列で、「東品川（最寄りは青物横丁…）」型は
  都道府県が取れず**勤務地の重み20が丸ごと0点**だった
- **経験年数を相対評価に**: `projects.required_experience_years` を追加
- **必須スキルの重み付け**: `skill_weights` jsonb。`skill_master.category` で傾斜
  （languages=4 … methodologies/others=1）、年数指定あり +2、記載順の先頭 +1、上限6
- **画面**: 詳細先頭の要約カード、「マッチングに使う条件」パネル、単価が消えるバグ修正

### 案件のLLM補正にガードを入れた

`shadow_worker.mjs:446` の `projectCycle` が案件をLLM補正している。
LLMが余計なものを足すので次のガードを入れた。

- `required_skills` は **regexが0件のときだけ fill**（既存への追加は全部ノイズだった。
  `Azure Functions` があるのに `AzureFunction` 等。必須スキルが増えると分母が膨らみ
  同じ候補者でもスコアが下がる）
- `role_summary` から体制語（メンバー・要員・担当者）を除外

### 解析経路

| 対象 | 何で解析しているか |
|---|---|
| 案件（取り込み） | **ルールベースのみ**。regex ＋ `skill_master` ＋ `station_master` |
| 案件（補正） | ThinkCentre の pm2 ワーカーが `claude -p --model claude-haiku-4-5` |
| 人材（取り込み） | 同じくルールベース |
| 人材（補正） | 同上のワーカー。1日100件・直近3日・Java/C#絞込 |
| マッチング採点 | Cerebras `llama3.1-8b` → Groq `llama-3.3-70b` → Gemini `2.5-flash` |

---

## 3. 監視ポイント

- 名簿行上限 70 化の副作用: 546（CPU限界）タイムアウトや幽霊増がないか
- C-ROSTER-CAP / C-ROW-LINK-SKIP / D-UNASSIGNED が減ったか
  （`npx supabase db query --linked -f scripts/sql/audit_roster_drops.sql`）
- egress: 8/11 は PostgREST 86.5MB（8/10 の366MBから76%減）。無料枠 5GB/月 ＝ 約166MB/日
- マッチングRPCの実行時間: 案件あたり 1.6〜7.1秒（`scripts/sql/bench_fetch_candidates.sql`）。
  RPC 内の `statement_timeout` は30秒なので余裕はあるが、遅くなったらここを見る

---

## 4. 積み残し

- **PDFからのスキル抽出**（取得率38% / Excel は95%）。152件が空のまま。上記§0参照
- **工程語が必須スキルとして機能していない**（テスト1,486人・基本設計1,141人）。判断待ち
- 案件の重複表示: 同じ案件の再送（条件更新版）が2件並ぶ。古い方を閉じる仕組みがない
- 尚可スキルは抽出済みだがスコアに未加算
- 面談回数・「※延長可能性あり」は保存する項目自体がない
- `work_prefecture` / `required_experience_years` は `PROJECT_FIELD_POLICY` に入っておらず
  LLM側は埋めない。AIにも担当させるなら追加が要る
- 氏名が壊れている人材が混ざっている（「オープン系」等）。`node scripts/audit_bad_names.mjs`
- `auto-match` は「新着500件をJS側で絞る」方式のまま。スキル判定は RPC に載せ替えたが、
  候補者の選び方自体はルールスコア順ではない。`fetch_candidates_for_project` を
  そのまま使う方が素直だが、提案メールに影響するので未着手

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
npm run build                                   # ★ tsc -b。Vercel が使うのはこちら
npx vitest run                                  # フロントのテスト（87件）
node scripts/test_excel_anomalies.mjs           # 合成異常系203ケース
node scripts/test_excel_parsing.mjs --compact   # Excel回帰（10件）＋Golden一致率
node scripts/audit_recent_quality.mjs 10        # 直近10件の読み取り品質
node scripts/audit_skillyears_gap.mjs 7         # スキル年数が取れない原因の内訳
node scripts/probe_skillyears.mjs <candidate_id>            # 抽出方式ごとの比較
node scripts/inspect_date_formatted_cells.mjs <candidate_id> # 日付に化けたセルを見る
node scripts/audit_replay_experience_impact.mjs 365 --all    # 再解析の影響を先に測る
node scripts/llm_extract/sb-query.mjs "candidates?select=id,name&limit=5"
```

SQL（`npx supabase db query --linked -f <file>`）:
```
scripts/sql/test_skill_matching.sql                  スキル判定の単体テスト
scripts/sql/test_skill_matching_rpc_parity.sql       定義と実体の突き合わせ
scripts/sql/test_match_skill_strings.sql             画面用RPC
scripts/sql/audit_skill_requirement_coverage.sql     必須スキルごとの充足人数
scripts/sql/audit_skill_match_looseness.sql          誤一致の洗い出し（旧ルール調査用）
scripts/sql/audit_replay_targets_by_filetype.sql     再解析対象をファイル種別で分ける
scripts/sql/bench_fetch_candidates.sql               マッチングRPCの実行時間
scripts/sql/snapshot_project_top20.sql               案件ごと上位20名（変更前後の比較用）
```

**注意**: `scripts/testData/excel/` は PII のため git 管理外。空だと回帰が Total 0 で
空回りする（合格に見える）。空なら `node scripts/download_failing_excels.mjs` で再取得。

---

## 7. egress を無駄遣いしないための鉄則

- **`raw_profile` を丸ごと select しない**（1件約35KB）。
  JSON パスで必要な項目だけ取る: `select=id,sy:raw_profile->skillYears`
- 件数は `select=count` で数える。レコードを取って数えない
- `sb-query.mjs` は既定で最大1000件返す。`limit` を必ず付ける

## 8. セッションを切る目安

作業セッション側の消費はワーカーより大きい（8/10 実測でキャッシュ読み687M）。
会話が伸びるほど毎ターン読み直す文脈が増える。**切るなら作業単位の完了時**。
調査の途中で切ると同じファイル読み直しが発生して逆効果。
