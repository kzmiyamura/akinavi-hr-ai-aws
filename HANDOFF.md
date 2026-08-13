# 引き継ぎ（2026-08-13 時点）

前回セッションのコミット範囲: `62b33c3..2ab235c`（13コミット）。全て push 済み。

---

## 0. 次にやること

### ★ 最優先: マッチングのバグ（8/13 午後に大量に出た）— 大半は修正済み

営業から「ちょっと見ただけで数個バグが見つかる。品質が悪すぎる」と指摘された。
**原因はほぼ全部「同じ判定が3か所に別実装されていて、片方だけ直っていた」型。**

| 実装 | 役割 |
|---|---|
| SQL `fetch_candidates_for_project` | 候補者の絞り込みと**順位付け** |
| `match-batch` | 画面の**内訳と保存スコア** |
| `src/lib/matchRuleScore.ts` | 未使用（import 元なし） |

**配点や判定を触るときは必ず3か所すべて見ること。**
確認は `node scripts/probe_match_batch.mjs <project_id> <candidate_id>...`
（UIを触らずに実案件×実人材の内訳が出る）。

修正済み（すべてデプロイ・push 済み）:

1. **勤務地が0点**（東京在住×東京の案件）。`work_prefecture` を渡していなかった。
   「東品川（最寄りは青物横丁…）」に都道府県が無いため文字列解析が失敗する。
   → `20/20(東京都・一致)` を実測確認
2. **必須スキルの合致数が過大**（5中3に見えて実は1）。match-batch に旧ルールの
   双方向部分一致が残り、`C`→Microsoft 365 / Azure Functions、`Shell`→PowerShell と
   誤合致していた。→ `match_skill_hits_batch` RPC を追加し判定を `skill_satisfies` に一本化
3. **リモート記載なしを「不可」と断定**。`remoteAvailable` が boolean 既定 false だった。
   → `deriveRemoteAvailable` で三値化（可/不可/記載なし）。画面にも根拠を表示
4. **スキル年数が経験年数を超える**（25歳・経験2年で PHP 16.3年）。
   → `capSkillYearsByCareer` で保存直前に「経験年数+1年」で頭打ち。実測 36ヶ月に是正
5. **スキルの重み付けが表示スコアに効いていない**（順位は重み付き・表示は単純比率）
6. **案件の必要経験年数を表示スコアが無視**
7. **フルリモート案件でリモート点が二重加点**
8. **単価の読み取りが壊れていた（影響大）**。順位付けSQLが
   `REGEXP_REPLACE(希望単価,'[^0-9.]','','g')` で数字を**連結**しており、
   「55万円以上希望（PMOなどは67万円）」→ 5567、「80万（140～180h）」→ 80140180。
   予算超過扱いで単価が0点になっていた。→ `parse_rate_wan` を追加（7ケース PASS）
9. **派遣の加減点が順位に入っていなかった**（表示側だけ±していた）
10. **NG先の会社を所属会社として登録**。「・NG：株式会社◯◯（NRI）様」を拾っていた。
    → `isNgContext` を追加。あわせて英字社名の頭欠け
    （`Next IT Consulting株式会社`→`Consulting株式会社`）も修正

11. **尚可スキルが順位側（SQL）で加点されていなかった**（8/13 修正・デプロイ済み）。
    `fetch_candidates_for_project` は尚可スキルを受け取ってすらおらず、
    match-batch だけが +10% 底上げしていた。`p_nice_skills` を末尾に足し、
    充足数は必須と同じ `skill_hit_weights`（＝`skill_satisfies`）で取る。
    あわせて match-batch 側に残っていた尚可の**双方向部分一致（+0.5pt）を廃止**し
    必須と同じ判定に一本化（必須と同じ往復でまとめて判定するので往復は増えない）。
    内訳に「尚可N中M合致」を出して加点の根拠を画面で見えるようにした。
    - 絞り込み条件は据え置き。**尚可だけ満たす人を新たに拾うことはしない**
    - 実測: 顔ぶれ1400件で不変・尚可を満たさない人の順位上昇0・275人が上昇
    - 所要時間 +0.32秒（1.13→1.44秒・サーバ側実測）。anon 上限15秒に対し余裕あり
    - `scripts/sql/test_fetch_candidates_nice_skills.sql` / `bench_fetch_candidates_nice.sql`
    - **注意**: この関数を直すときは手で書き写さず
      `python scripts/gen_fetch_candidates_nice.py <入力sql> <出力sql>` 方式で機械生成する
      （200行あり写経ミスで配点が変わる）。クライアント経由の時間計測は転送とネットワークの
      揺れで 4.9〜10.1秒とばらつくので、差を見るなら bench の方（サーバ側・egress ゼロ）を使う

12. **汎用スキルだけの人が上位に入っていた**（8/13 修正・デプロイ済み）。
    PowerShell案件の上位20人中4人が PowerShell も Azure Functions も持たず
    「基本設計」だけで入っていた（高速モードは上位20件しかAI採点しないので実害大）。
    `skill_master.is_generic` を追加し、**分類が技術名でない（methodologies/others）
    かつ充足率がしきい値（40%）以上**のものだけを汎用とする。現在は テスト(74%)・
    基本設計(58%) の2件。Java(47.6%)・SQL(77.3%) は技術名なので対象外。
    `selective_skills()` で「汎用を除いた必須スキル」を返し、
    `fetch_candidates_for_project` の**絞り込み**と `auto-match` の事前フィルタに適用。
    **配点は変えていない**（汎用スキルの合致は従来どおり加点される）。
    - 結果: 上位20人中4人 → 0人。候補は 1,141→319人
    - 人材が増えると充足率が動く。`scripts/sql/refresh_generic_skills.sql` を
      `refresh_skill_norm_map.sql` と同じタイミングで回すこと
    - テスト: `scripts/sql/test_selective_skills.sql`

### 判定材料は画面に出す（8/13 のユーザー指摘）

「判定に使った情報は出さないと本当か？となる」。人材カードに
リモート可否（3値）・派遣可否・勤務形態の原文を表示するようにした。
**スコアの根拠になっている項目は画面に出す。根拠が無いものを断定しない。**

### スキル辞書の拡充（8/13・第一段のみ完了）

営業指摘:「この案件は Windows/Azure/M365 という Microsoft 知識全般を問うている。
単語一致では拾えない」。まず辞書で埋まる分を入れた（判定ロジックは変更なし）。

- `Azure Active Directory` の別名に `EntraID`/`AzureAD`/`Microsoft Entra ID`（2023年改称）
- `Microsoft Graph` を追加（案件本文の `GraphAPI`）
- `PowerShell` の別名に `PowerShell Core`/`pwsh`
- 包含関係3件（`Azure Functions→Azure` 等）

効果は小さい（`Microsoft 365` 178→185人）。**辞書では本質に届かない。**
この案件の肝は「2名セット・2名で補完できれば全部満たさなくてもOK」で、
1人あたりの充足率で測る限り読めない。

**→ 対応済み（8/13 実装・prod 8案件に適用済み）**: 案件登録時に**1回だけ**LLMに
条件を解釈させ、`複数名前提` フラグと `関連スキル` を立てる仕組みを入れた。

- 保存先は `raw_data.aiInterpretation`（multiPerson / evidence / relatedSkills+根拠 / confidence）。
  関連スキルは `raw_data.niceToHaveSkills` に**統合**（＝既存の尚可経路にそのまま乗る。
  必須の分母は増えない）。元の尚可は `_regex_backup.niceToHaveSkills` に退避
- 受け入れ条件: skill_master にある技術名のみ（無いものは判定できず足しても効かない）・
  必須/既存尚可と正規化キー重複なし・confidence=low は記録のみで**未適用**・最大8件
- ワーカー: `shadow_worker.mjs` の `projectInterpretCycle`（キュー方式・
  `raw_data->>aiInterpretation is null` の open prod 案件・結果ゼロでも印を書く）。
  **ThinkCentre 側は git pull + `pm2 restart akinavi-shadow` が必要（未実施）**
- 手動実行/検証: `node scripts/llm_extract/interpret_projects.mjs [--run|--id X --force]`
  （既定ドライラン・ワーカーと同じ関数を使う）
- 純関数テスト: `node scripts/llm_extract/test_interpretation_patch.mjs`（17 PASS）
- 画面: 案件詳細・マッチング画面の尚可チップに **点線+「AI」バッジ**（title に根拠）、
  複数名前提は「複数名で補完可 AI解釈」バッジ（title に本文の根拠引用）
- 実測: 営業指摘の Azure Functions 案件で multiPerson=true
  （根拠「2名セット、2名で補完できるようであればすべてを満たさなくてもOK」）。
  他案件で SQL/SWIFT/Excel VBA/Git 等が尚可入り
- **注意**: スコアは再マッチングするまで変わらない（保存値のまま）。
  複数名前提フラグは**表示のみ**でスコアには未反映（充足率の按分は次の判断待ち）。
  LLM出力は揺れる（同じ案件でも回によって confidence が high/low に割れた）。
  `PostgreSQL`（Spring Boot の推測）のような当て推量が混ざることがある——尚可なので
  減点にはならないが、気になるならプロンプトの「推測禁止」を強める

**⚠ skill_master を触るときの鉄則**: 新規行を作らず**既存行の別名を増やす**。
`EntraID` を新しい行として作ったら充足者が 28人→1人 に落ちた
（既存の `Azure Active Directory` 行が別名 `Entra ID` を持っており canon を奪ったため）。
更新後は `scripts/sql/refresh_skill_norm_map.sql`、前後で
`scripts/sql/audit_project_requirement_coverage.sql` を比べる。


### ✅ 解決済み: マッチングRPCが anon でタイムアウトしていた（8/13 修正・デプロイ済み）

**UI の「再実行」は open 8案件中5案件で毎回失敗していた。** スコアが古いまま／
「未実施」のままだったのはこれが原因。スキル判定の問題ではなかった。

**anon の `statement_timeout` は 3秒**（authenticated は8秒、service_role は実質8秒）。
本アプリは認証なしなので常に anon。ここに 7.3秒の RPC を投げていた。

関数の先頭に `PERFORM set_config('statement_timeout','30000',true)` があるが
**実行中の文には効かない**（タイマーは文の開始時に決まる）。`ALTER FUNCTION ... SET` も同じ。
§3 の「1.6〜7.1秒・timeout 30秒なので余裕」は CLI（superuser）計測だったので実態と違っていた。

やったこと:

1. **`fetch_candidates_for_project` の高速化**（`20260813_fetch_candidates_perf.sql`）
   7.34秒 → **3.2秒**。`candidates_lite` は `raw_profile - 'text' - 'parsedGrid'` を
   行ごとに評価するビューで、旧実装は ORDER BY / LIMIT の**前に全該当者ぶん**展開していた。
   スコア計算を軽い列だけで先に済ませ、**返す500件に対してだけ**ビューを結合するよう変更。
   配点・判定は一切変えていない
2. **anon の statement_timeout を 3秒 → 15秒**（`20260813_anon_statement_timeout.sql`）
   3.2秒でも3秒の壁は越えられないため。戻すときは `ALTER ROLE anon SET statement_timeout = '3s';`
3. **open 8案件すべて再マッチング済み**（合計約3,000件 upsert・Groq 70B）

確認したこと:
- 移行の前後で背中合わせにスナップショットを取り、**7案件で候補者IDの並びまで完全一致**
  （1件は変更前がタイムアウトで比較不能）
- anon で 8案件×3周＝24回、**失敗ゼロ**（変更前は 2〜4件/8 が失敗していた）
- test_skill_matching.sql 28/28、rpc_parity 1,570人・食い違い0、
  test_match_skill_strings PASS、vitest skillMatch 7/7

**注意**: スナップショットを時間差で2回取ると必ず差分が出る。裏でワーカーが人材を
更新しているのと、同点が多い案件（英語のみ等）で並びが揺れるため。
関数変更の検証は**変更の直前直後**に取った2点で比べること。

内訳の実測（次に遅くなったとき用）:
`skill_hit_weights` 0.77秒 / `candidates_lite` 500件の組み立て 0.74秒 / 残り約1.7秒。

切り分けツール:
```
node scripts/probe_fetch_candidates_timing.mjs <案件id先頭> [--service]  # スキルを足し引きして計測
node scripts/snapshot_rpc_ranking.mjs <出力> [--anon]                    # 並びを保存
node scripts/compare_rpc_ranking.mjs <before> <after>                    # 差分
npx supabase db query --linked -f scripts/sql/inspect_role_timeouts.sql  # ロール別の上限
```

**egress に注意**: 上記スナップショットは1回で約8MB（500件×約2KB×8案件）使う。
日次の目安は166MB。**安定性の確認は1案件・少件数で足りる**。8/13 は3回×2セット回して
約35MB を無駄にした。

### ★ スキル緑表示の件: 白と確定（8/13 目視完了）

ブラウザで M.K の必須スキルパネルを確認。**SQL のみ緑、C# は取り消し線**。
新しい判定がフロントに正しく効いている。原因は旧デプロイという読みどおりだった。

なお同じ画面のスコア内訳は「必須6中6合致」と出ていた。これは上記のとおり
**再マッチングが失敗し続けて保存値が古いままだった**ため。緑表示（毎回RPC）と
スコア（保存値）で判定時点が違う点に注意。

<details><summary>以下、8/13 の切り分け経緯（解決済み）</summary>

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

（目視完了。上記のとおり C# は取り消し線だった）

</details>

### ✅ 対応済み: PDF からのスキル抽出（8/13 実装・デプロイ済み）

取得率は **PDF 42% / Excel 95%** だった。原因を先に測ったところ:

- **スキャンPDF（テキスト層なし）は0件**。空の116件は全件テキストもスキルも取れていた
- 空だったのは**年数だけ**。つまり抽出器の問題で直せる領域だった

理由は「PDFに年数の入る場所が無い」から。Excel はスキル表のセルに年数が入るが、
叙述型の職務経歴書は**期間見出しにしか年が無い**:

```
2017年4月〜2023年4月 ｜ 株式会社W
● サーバリプレイス・インフラ移行： オンプレミス→CCMS
```

`extractSkillYearsFromBodyText` は「Java 5年」型の明示表記しか拾えないので素通りしていた。

**`extractSkillYearsFromCareerBlocks` を追加**（`index.ts`）。期間見出しを拾い、
次の見出しまでを配下ブロックとみなし、ブロック内の skill_master スキルにその期間を
割り当てて union する。Excel の `extractSkillYearsVisualProject` のテキスト版で、
期間の重なりを union する点まで意味論を合わせてある。

- 全スキル走査は**全文に1回だけ**。ブロック×全件を回すと546に落ちる
- 信頼ゲート: 期間見出し2本以上・結果3件以上
- 期間が3行に分かれる表に対応。**窓は必要な分だけ広げる**（常に3行つなぐと隣の案件の
  日付を拾い、1案件3.8年のスキルが20.3年に膨らんだ）
- Excel/Word でスキル表が取れているときは**触らない**（95%の経路は動かさない）
- 名簿パスでは他人の経歴書を拾わないよう、添付が本人に確定しているか名簿が1人のときだけ

あわせて `projParsePeriod` に**月の範囲検証**を追加（Excelと共用）。
「(2026/05/18 現在)」の `05/18` が 2005年18月として通り20年ブロックに化けていた。

効果（実データ30件サンプル）: **復元 15件(50%) / スキル数の中央値 25**。
本番で再解析して AH 48件・T.H 39件・Y.S 4件。T.H の経験年数26年は経歴書の
「経験年数 26年10ヶ月」と一致した。

**既存分の一括再解析も実施済み**（`--pdf`・110件実行）: 31件回復・失敗3。
prod の PDF 経歴書の取得率は **42%（84/200）→ 60%（120/200）** になった。
サンプルの50%より低いのは、古い取り込み分や名簿由来が混ざるため。

回帰: Excel Golden 100.0%（207/207・欠落0・値ズレ0・過剰0）、合成異常系 203/203 PASS。

```
node scripts/test_pdf_career_skillyears.mjs --limit 30 --verbose  # 復元率と落ちどころ
node scripts/probe_pdf_text.mjs <candidate_id> [--grep 年]        # 実PDFの行を見る
npx supabase db query --linked -f scripts/sql/audit_pdf_skillyears_gap.sql
node scripts/bulk_replay_missing_skillyears.mjs 365 --run --pdf   # 既存分の再解析
```

**残り**: 30件サンプルで50%は0件のまま。ほぼ全部が「期間見出しが2本未満」で、
内訳は ①`2年0ヶ月` のような**期間長表記**（日付範囲が無い）②単一職歴。
①は Excel 側の `skillFloat`（期間長を加算）に相当する処理を足せば拾えるが、
「経験年数 26年10ヶ月」のような**合計値まで案件として加算してしまう**危険があるので
未着手。やるなら合計行の除外規則とセットで。

**注意**: 名簿メール（`multiCandidateBlock: true`）の人は
`bulk_replay_missing_skillyears.mjs --id` で再解析しても本人のPDFがブロックに
割り当たらず空のままになることがある（K.H で実測。16人名簿の1ブロックだった）。
これは再解析ツール側の添付割当の問題で、抽出器の問題ではない。

**別件で見つけた既知の汚れ**: `SNS`（ソーシャル）が skill_master の
`AWS SNS` / `Amazon SNS` の別名に一致する。今回の変更以前から `skills` 列にも
出ていて、今回それが skillYears にも出るようになった。skill_master の別名整理が要る。

### 既知の失敗: M.S が 546（WORKER_RESOURCE_LIMIT）で再解析できない

`2d131015-d64e-4457-98db-54dedb06ce7b`。3回試して3回とも 546。**変更前から失敗している**。

- 入力サイズ起因ではない: 本文1,116文字（prod中央値1,483より小さい）、
  シートは13〜14行・37〜42セル。`scripts/sql/audit_candidate_payload_size.sql` で確認
- ファイル自体は 275KB。シートが小さいのにこのサイズ＝書式・図形が重いとみられる
- ログ上は `[Excel-parse]` まで進んでから落ちる。`tryVisualSkillExtraction`
  （罫線・色のために生バイトを読む）が怪しい
- ローカルでは2枚目「スキルシート（修正版）」から12スキル取れる

### 8/13 に決めて処理したもの（旧「判断待ち」）

判断待ちを項目名だけ並べて投げるとユーザーに伝わらない。測って自分で決めること。

- **工程語（テスト・基本設計）** → **対応済み**。「汎用スキルだけの合致では候補にしない」
  を入れた。詳細は上の 12 番
- **隔離済み89件の削除** → **消さない**。マッチングには出てこないので害がない
- **ワーカーの日次上限引き上げ** → **上げても効かない**。実績は 75〜78件/日で
  上限100に届いていない（`node scripts/llm_extract/usage_split.mjs 3`）。
  ボトルネックは上限ではなくスループット。
  **未処理が滞留している**: 8/10以降に入った1,277人のうち961人が未処理、
  うち絞込対象（Java/C#）だけで424人。1件あたり約85秒かかっている計算になる。
  次にやるならここ（上限ではなく処理速度・キュー取得条件を見る）

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
- マッチングRPCの実行時間: 高速化後で **3.2秒**（anon の上限は15秒＝8/13に3秒から引き上げ）。
  `scripts/sql/bench_fetch_candidates.sql` は CLI（superuser）で測るので**本番の余裕は分からない**。
  本番の条件で見るなら `probe_fetch_candidates_timing.mjs`（anon）を使う。
  RPC 内の `PERFORM set_config('statement_timeout',...)` は効かないので当てにしない
- **接続の詰まり**: anon を 15秒に緩めた副作用（長時間クエリの居座りで接続を食い潰す）は
  8/13 に確認して**発生なし**（非 idle は自分自身の1本のみ・実行秒0）。画面の体感も速いまま。
  重くなったら `npx supabase db query --linked -f scripts/sql/inspect_active_queries.sql`

---

## 4. 積み残し

- **PDFの期間長表記（`2年0ヶ月`型）からの年数復元**。日付範囲が無い経歴書は今も空。
  上記§0の「残り」参照（合計行の除外規則とセットで実装する必要がある）
- **skill_master の別名汚れ**: `SNS` → `AWS SNS` / `Amazon SNS`。上記§0参照
- **工程語が必須スキルとして機能していない**（テスト1,486人・基本設計1,141人）。判断待ち
- 案件の重複表示: 同じ案件の再送（条件更新版）が2件並ぶ。古い方を閉じる仕組みがない
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
