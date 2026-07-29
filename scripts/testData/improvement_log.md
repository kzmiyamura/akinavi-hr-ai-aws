# skillYears 改善ログ

## ベースライン
- Excel skillYears: 67.4%
- Word skillYears: 31.8%
- Excel 会社名: 36.0%
- Word 会社名: 68.2%
- Excel remoteStyle: 7.7%
- Word remoteStyle: 31.8%

---

## 2026-07-04 イテレーション1
- **発見パターン**:
  - `extractSkillYearsFromSheetData` で `経験年数: 15年` を見つけると早期returnしてMethod1-3をスキップしていた（KM型Excelで多発）
  - `Java(約15年以上)` の「約」プレフィックスがpattern3でマッチしない
  - `Springboot(6ヶ月)` のように月数のみの括弧形式が未対応
  - `Laravel歴7年以上` のような「歴N年」形式が未対応
  - 【スキル】後のスラッシュ区切り `Java(約15年以上) / Kotlin(約8年)` が未対応
- **追加ロジック**:
  - `extractSkillYearsFromSheetData`: 早期returnを廃止→headerTotalMonthsに保存して続行
  - `extractSkillYearsFromBodyText`: パターン3b（Nヶ月括弧）・3c（歴N年）・3d（スラッシュ区切り）追加
  - `extractSkillYearsFromBodyText`: パターン3に「約」オプショナル追加
- **テスト追加**: 13件（全149件パス）
- **Excel skillYears**: 67.4% → 68.3% (+0.9%)
- **Word skillYears**: 31.8% → 31.8% (変化なし)
- **会社名**: 変化なし

---

## 2026-07-04 イテレーション2
- **発見パターン**:
  - `g1991.10` のような `g` プレフィックス＋ `.` 区切り日付が未解析（YK型Excel）
  - `六ヶ月`・`一年九ヶ月` などの漢数字期間が未対応（OY型）
  - `作業月数` 列が純整数の場合、`parseDurationToMonths` がnullを返していた
- **追加ロジック**:
  - `parseDurationToMonths`: 漢数字（零〜十二）サポート追加
  - `calcMonthsFromDates`: `.` 区切り日付・`g/h/r/s` プレフィックス除去
  - Method 1: `作業月数`・`月数` 列を純整数として読む `durationColIdx` 追加
  - `TEXT_DATE_RE`: `1991.10` 形式・`g` プレフィックス対応
- **テスト**: 149件（全パス）
- **Excel skillYears**: 68.3% → 74.6% (+6.3%)
- **Word skillYears**: 31.8% → 51.6% (+19.8%)
- **会社名**: Excel 30.7% / Word 47.8%

---

## 2026-07-04 イテレーション3
- **発見パターン**:
  - `言　語`（全角スペース入り列名）が `extractSkillYearsFromSheetJson` でマッチしない
  - `学歴`・`氏名`・日付範囲がスキル名として誤抽出されている
  - `経験年数：N年` が `_totalProjectMonths` に変換されていない
- **追加ロジック**:
  - `extractSkillYearsFromSheetJson`: 全角スペース除去で列名正規化（`normalizeHeader`）
  - `filterSkillYears`: 個人情報ラベル（学歴・氏名等）と日付範囲をブロックリスト追加
  - `extractSkillYearsFromBodyText`: パターン6（経験年数ラベル → `_totalProjectMonths`）追加
- **テスト**: 151件（全パス）
- **Excel skillYears**: 74.6% → 74.8% (+0.2%)
- **Word skillYears**: 51.6% → 52.2% (+0.6%)

---

## 2026-07-04 イテレーション4
- **発見パターン**:
  - `製品/OS/言語／DB\nツール` 型複合列が `言語` 検出に失敗（DBとOSの複合ヘッダー）
  - `期間: 22` のような純整数月数列を持つH.I型Excel
  - `extractSkillYearsFromSheetJson` で `期間` 列の純整数を使えていなかった
- **追加ロジック**:
  - Method 1: `言語/DB` や `言語/OS` を含む複合ヘッダーも `langColIdx` として検出
  - Method 1: `^期間$` を `durationColIdx` 検出対象に追加（純整数ガード付き）
  - `extractSkillYearsFromSheetJson`: `rawPeriodIsIntMonths` で `期間` 列の純整数対応
- **テスト**: 151件（全パス）
- **Excel skillYears**: 74.8% → 74.8% (変化なし)
- **Word skillYears**: 52.2% → 52.9% (+0.7%)

---

## 2026-07-06 バグ修正: multi-candidate 添付ファイル誤割当（labelToAttachment ラベル衝突）
- **発見経緯**: ユーザー報告「A.SにT.Tの経歴書がついてる」（株式会社ai・more の5名複数人メール）。
  DB確認で K.S/T.I/Y.F/A.S の4名が同じ `shared_*.xlsx` を指し、その中身は実際には T.T の経歴書だった。
- **根本原因**: `labelToAttachment`（旧: `Map<label文字列, 元添付データ>`）が `att.name` 由来の
  ラベル文字列（例: `Excelファイル(スキルシート.xlsx)`）をキーにしていたため、同一メール内に
  同名の添付ファイル（代理店の汎用テンプレ名等）が複数あると `Map.set` の後勝ちで上書きされ、
  ケースA（マッチ確定ブロック）のアップロードやケースB（未割当共有）の探索が
  別人の生添付データを参照してしまっていた。
- **修正内容**:
  - `officeTextContents` の各エントリ（Word/Excel）に元添付データそのもの (`attachment: att`) を直接保持させ、
    ラベル文字列を介した間接参照 (`labelToAttachment.get(label)`) を廃止
  - ケースA: `matchedTextContent.attachment` を直接参照
  - ケースB: `blockAttachAssignment.values()` をオブジェクト参照の `Set` として保持し、
    `allTextContents.find(t => !assignedEntries.has(t) && t.attachment?.data)` で
    参照同一性ベースに未割当添付を検索（ラベル衝突の影響を受けない）
  - `labelToAttachment` Map 自体を削除
- **テスト**: `test_excel_parsing.mjs --compact`（回帰17件）・`verify_email_extraction.mjs` 全パス
- **デプロイ**: `check-and-deploy-edge.sh inbound-email` 実施済み

---

## 2026-07-10 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 設計書v4準拠の統一入力パイプライン実装: 4系統入力(添付/Drive/Sheets/Docs)をSourceEntryに正規化。Sheets=XLSX本流+CSVgidフィンガープリント照合/保険、Docs=DOCX本流+txt保険、タイムアウト20秒統一。名簿判定・行展開(detectRoster/expandRosterEntries、リンク型は深さ1で再取得)。単一人材の氏名照合ゲート(gateSingleCandidate)。resume_url優先順位反転(Storage>本文リンク、resolveResumeUrl)。skillYears本人割当のみ(pickSkillYears、driveSheetSkillYears廃止)。ゾーンT台帳(createLedger/pipeline_trace/不変条件チェック)+scripts/trace_email.mjs新設。回帰: regex154/154・Excel 10P/4W/0F(0件劣化)

---

## 2026-07-11 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: ローカル完全テスト環境構築で重大バグ2件を発見・修正: ①detectRoster誤検出（縦型経歴書のラベル列/複数シート跨ぎ氏名を名簿と誤認→ゴミ候補者・同一人物重複登録。修正: 名簿ヘッダ行検証+氏名値妥当性チェックlooksLikeRosterName+行連続性+同一シート内判定）②spanCellsToJson組合せ爆発（459結合セルの経歴書で1シート30-60分→本番Edgeはワーカー強制終了=silent drop。修正: 5秒時間予算+再帰内console.log削除）。検証: ローカルSupabase(ポート5433x)+実ファイル21テスト(Excel13+Word3+名簿1+複合4)で21/21パス。本物の名簿(117人・F.K含む)の行展開・D-NEWBLOCK昇格も動作確認。回帰: regex154/154・Excel10P/4W/0F(0劣化)

---

## 2026-07-12 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 実Googleリンク結合テスト（名簿内の実リンク4本・ローカルE2E）で3件の実環境バグを発見・修正: ①fetchCsvFingerprintのCSVパースが引用符内改行で壊れgidフィンガープリント照合が実データで不発（1パス実装に修正→実ファイルで19/20一致・B-SHEET-GID動作確認） ②実DOCXで氏名ラベル2回→同名を名簿と誤認し1人が2候補者に分裂（相異なる氏名2人以上を名簿条件に） ③Google Driveのdisposition生UTF-8でファイル名文字化け（latin1→UTF-8再デコード）。実リンクでSheets XLSX本流→スキル年数43件→Storage→resume_urlの一気通貫、Drive実PDF経路も実証。分岐網羅114/114・E2E 21/21・回帰0劣化

---

## 2026-07-12 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: リンク型名簿の完全対応（設計書v4最後の未達機能）: ①detectRosterにサマリー列名簿検出を追加（氏名ヘッダ列なし・【氏名】入りセル縦並び形式。グリッドは文字数上限の影響を受けないため旧9/117問題も同時解消） ②名簿昇格ブロックと行エントリの1:1確定割当（ラベル曖昧マッチはリンク先英文の偶然一致で全滅するため） ③リンク取得60秒予算（Edge時間制限対策・超過行は埋め込み降格） ④氏名の：プレフィックス除去。実名簿E2E: 1通49秒で14人登録・全員に本人のリンク先経歴書のStorage URL・スキル26-85件・違反0。分岐網羅119/119・E2E 21/21・回帰0劣化

---

## 2026-07-12 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 転置名簿対応+リンク先氏名検証: ①detectRosterに転置フォールバック追加（人が列方向に並ぶ名簿。グリッド転置+セル番地の列→疑似行番号変換で行方向と同一経路・行方向優先） ②リンク先氏名検証C-ROW-LINK-REJ（取得した経歴書に本人の氏名/イニシャルが無ければ採用見送り・埋め込み降格。行ズレ/転置ミスで他人の経歴書を紐づける事故の最終防衛線）。検証: 分岐網羅123/123・E2E21/21・実名簿30秒14人（全員Storage URL・検証通過）・回帰0劣化

---

## 2026-07-18 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: PDF抽出の部首正規化バグ修正: 康熙部首・CJK部首補助（⽒→氏・⻄→西等）をnormalizePdfRadicalsで通常漢字へ正規化。unpdfを@1.6.2に固定。実PDF（Chrome生成）で【氏名】regex全滅を確認→修正後6/6チェックPASS

---

## 2026-07-18 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: スキル年数の期間マージ化: プロジェクト日付が取れた行はスキルごとに区間の和集合で月数化（並行案件の二重カウント解消・年齢超え対策）。日付なし行は従来どおり加算。連続・非重複案件は従来値と完全一致（回帰0劣化）

---

## 2026-07-18 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 想定異常系スイート新設(test_excel_anomalies.mjs・34ケース)。発見バグ2件修正: ①sync_extractorsの後置!除去が正規表現リテラルを破壊(#REF!フィルタがテスト版のみ無効化)→リテラル退避で保護 ②元号年の誤変換(H30/4→2030年)→昭和/平成/令和の正式換算を追加

---

## 2026-07-18 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:12 Warn:2 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: Method 1.7 KVブロック型を新設: No.|期間|内容のブロックヘッダー繰り返し+行ラベル(環境等)形式をマイニング。スキルはExcelステートマシンのKV/コンテナ読みの考え方をグリッドに適用。S_I/Y_MがWARN→PASS(10P/4W→12P/2W)。誤発動ガード: 期間列±3列限定・実スキル3件未満は不採用・トークン浄化

---

## 2026-07-19 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: Downloadsフォルダ56ファイル実地スイープで発見したゴミスキル4系統を修正: ①ラベル残骸(期間：/能力指標：/ﾌﾘｶﾞﾅ/能力判断) ②会社名(株式会社〜/法律事務所) ③勤務形態・単価レンジ(フルリモート/常駐可/88-93/応相談) ④文章断片(読点分割後の助詞終わり)。H_O/Y_SのPASSは偽物(ゴミのみ)だったためWARN化=正直化。異常系D11-D15追加(44ケース)

---

## 2026-07-20 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: KVブロック型の異常系埋め込み(G6-G11): 「現在」終了・1セル日付範囲・縦積み日付・インラインラベル(環境：値)の4パターンを実装で対応。期間列位置ズレ・期間逆転は既存で耐性確認。異常系50ケース全PASS・回帰劣化ゼロ

---

## 2026-07-20 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: スキル年数の抽出経路を永続記録: _extractMethod(10/15/16/17/20/30/41/43-46/50)をraw_profileに、B-SY-METHODをpipeline_traceに記録。KVブロック含む全経路のデバッグと「M20(最後の受け皿)比率上昇=劣化サイン」監視の土台

---

## 2026-07-20 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 精度重視への転換: ①方式勝者選択を件数→skill_master照合の品質スコアへ(ゴミ多出し方式が勝てる欠陥+方式2だけフィルタ後という選択バイアスを解消) ②ゴールデンテスト新設(excel_golden.json 14ファイル186スキル値の厳密比較・一致率100%でベースライン確立)

---

## 2026-07-20 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:10 Warn:4 Fail:0/14）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: レイアウト全面対応(第1〜4弾): 半角ｶ月/ヵ月・シリアル1970年〜・縦積み日付(F.K)・日付ペア×テキスト突き合わせ(MK/N_Y)・空白入り日付/丸数字/開発環境列(K.J)・M1.8期間|業務内容繰り返し表・和暦元年・現在終了・No列なし行(O.M)・横断走査(RH)・B.S型ブロック・M1.9セル内テキスト期間(H.M)・方式7文章行(TA)・分割セル日付(M.N)・K.I型遠隔期間列。名簿実測63→96/111人(87%)。残15件は個別変則型(ログ参照)

---

### 残存する未対応レイアウト15件（2026-07-20時点・名簿リンク先111件中）

| 種別 | 対象 | 型の特徴 | 対応方針 |
|---|---|---|---|
| Word構造なし | YK, SR, M.E, MY, M.K(104), Y.R | mammoth変換で表も日付段落も取れない（テキストボックス/段組み/非ITキャリアの可能性） | docx XML直読 or AIフォールバック領域 |
| Word行内期間が少数 | H.S | 「2026年4月～現在就業」形式はあるが期間行3行未満でM1.9発動せず | 発動閾値の検討（誤爆とのトレードオフ） |
| 個別変則sheets | K.R×2, TY, T.Y, N.Y, M.S, L.Z, OR | 各1件ずつの固有レイアウト（装飾ヘッダ・項番変種・年月ラベル型・カタログのみ等） | 実流入で再登場した型から個別対応 |
| PDF | 6件 | テキスト層ありPDF（本番はunpdf経路で処理される。ローカル簡易判定対象外） | 復旧後に本番実測 |

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 視覚エンジン2点改善: (1)ヘッダー判定をfill色単独→罫線ボックス考慮に変更しゼブラ縞/強調色の本文行を丸ごと捨てる不具合を解消(KS 10→22件回収) (2)空行でコンテナ分割しskill系ブロックだけ視覚読み+明示スキル表を勝者第一優先に変更、混在シート(004/028/052)のスキル表を回収。回帰0劣化(192/192)、visual勝者5件は全て明示スキル表持ちで誤発火0

---

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 視覚コンテナ判定を拡張: 絶対日付ゼロ&相対期間3件以上も明示スキル表と判定(M.K型4件の小表を回収)。副作用の役割サマリ(PG,SE,PM等)誤発火は視覚結果3件未満を不採用にして排除(語彙非依存・件数で弾く)。視覚勝者6件=全て真の明示スキル表・誤発火0・回帰0劣化

---

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚プロジェクトリーダーを本番搭載: スキル表が無い案件履歴で、縦結合セルにより1案件=複数行ブロックを認識し、ブロック内の期間(開始〜終了/期間)をtech(指定列＋【OS】【言語】等の自由記述分解)に区間unionで付与。信頼ゲート(tech列2本+案件3件+結果3件)を通った時のみgridより優先(_extractMethod=61)。goldenを私が85名手読みして採点: 構造良42名で視覚71%/grid50%・精度83%。並行案件の被りを潰す区間unionで年数の二重計上も解消(016 C#45→14年)。回帰0劣化

---

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚リーダーの見出し検出を強化: (1)見出しの字間スペース除去('O S'→'OS'、'期 間'→'期間')(2)全角ＤＢ・使用ＤＢ・FW/Tool等をtech列に追加。010型(OS/言語/FW縦積み+DB別列+字間空け見出し)が0件→復活。手読み43名でv3再現率28→37%(grid35超え)、全体65%(grid47)。回帰0劣化

---

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚リーダーのヘッダー検出をさらに強化: 直下に日付行が続く行を案件表ヘッダーとして優先(PR/要約欄の単発tech語誤選択を排除)、長い結合見出し(開発環境（OS／言語…）)を30字までsubstring照合、技術スタック追加。040が0→正解一致(React/TS/Next.js等)、手読み43名でv3再現37→42%。回帰0劣化

---

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚リーダー: tech列数を強く重み付け(2行ヘッダーで粗い行より細かい列見出し行を優先)＋接頭辞形式(言語-/OS-/DB-)対応。045(モバイル34年・2枚目シートのヘッダーr7[OS/DB/言語/利用技術]を正しく選択)が0→Swift/Dart/Kotlin/Flutter取得。手読み43名でv3再現42→47%。回帰0劣化

---

## 2026-07-25 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: スキルリーダーの年数解釈を拡張: 明示スキル表の年数欄に多い『N年以上』→N年、『1-2年』『0.5-1年』(範囲)→上限、に対応(VISUAL_REL_DUR_RE+strictDurationToMonths)。014(Go/C#/Java等の明示スキル表・年数が10年以上/1-2年形式)が0→Java10/Go3/C#5等取得。KS/K.R無傷・回帰0劣化

---

## 2026-07-26 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚リーダー: No列等の縦結合セルを案件境界に使いブロック化(No毎に1案件・結合が全行を覆う型に対応)＋複合名(SQL Server/PL/SQL/Visual Basic等)を分割しない保護。074(DBA/PMO 28年)が0→12/12=100%。全85再現66%/精度49→51%、手読み43再現47→50%。回帰0劣化

---

## 2026-07-26 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚リーダー: 期間抽出をtech列の左右問わずブロック内全非tech列に拡張(期間列がtech列の右にある表・020型に対応)。020(C#.NET開発)が全部28年→C#/C言語/SQLServer/VB/Oracle取得。手読み43名の再現率50→60%(期間右置き表が多く広く効いた)。回帰0劣化

---

## 2026-07-26 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 案件系視覚リーダー2点修正: (1)期間をtech列の左右問わずpcols＋左側から抽出(020型:期間列がtech右) (2)parseKakkoが最初の【】より前の平文techを捨てるバグ修正(119型:tech列に隣の業務説明【PJ詳細】が横に混入)。020(C#.NET)と119(ゲーム/VR C++/C#/Unity)が0→復活。手読み43再現50→61%。回帰0劣化

---

## 2026-07-26 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: looksLikeRosterName: データベース/ネットワーク等カタカナ分類語を人名判定から除外。1人スキルシート(Y.M_沼津.xlsx)を名簿誤検出しゴミ候補者化＋本物添付のresume_url欠落を招く事故を修正。K1-K10テスト追加

---

## 2026-07-28 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: cells(method50)をunion化: 案件跨ぎの同一スキル月数を単純加算→暦区間unionで二重計上を解消(M.T Excel 7.6→6.4年)。cellToText共通化+cellDates:trueで書式無し日付セルを yyyy/M/d に統一。sync stripper: new Set<T>()破損修正+custom型パラメータ対応。cells系抽出関数をgenに追加(検証可能化)

---

## 2026-07-28 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 多人数メールの名無しブロック(署名等)が添付から兄弟の名前を拾い既存候補者をnull上書きする汚染を修正(スキップ+UPDATEマージ化)。会社名サニタイズに「で御座います」漢字対応。駅名「路線 駅 X」逆順対応。poll-emailロック未解放修正

---

## 2026-07-28 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: skillYearsゴミ根絶: Method17の文章セル吸い込み修正・パターン8cの経験N月誤採用修正・filterSkillYears拡張(期間表記/日付/見出し語)・保存直前の共通フィルタ適用(multi/single両パス)。過去分102行557キーをSQL掃除

---

## 2026-07-29 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 多人数ブロックのskillYears抽出から共通件名を除外(件名PMO(約6年7ヶ月)が名簿展開の兄弟5人全員に誤付与された実害)。filterSkillYearsに見出し語連結キー正規化(QAエンジニア 経験年数→QAエンジニア)と総経験ラベルキー(IT/業界/総経験年数等)の丸ごと除外を追加。prod残存ゴミ15キー掃除

---

## 2026-07-29 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:11 Warn:4 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 本文パターン追加(#123): 箇条書き密着型「・JAVA10年以上」とプロース型「Javaは10年近くの実績」からスキル年数抽出。IM再解析でJava:120復元(業界名ジャンク保険/銀行等は消去)

---

## 2026-07-29 イテレーション（自動記録）
- **Excel skillYears**: 100.0%（Pass:15 Warn:0 Fail:0/15）
- **Body skillYears**: 100.0%（Pass:3 Warn:0 Fail:0/3）
- **メモ**: 期間ヘッダー型3ギャップ修正(K_M:4年/YYYY-MM日付/【環境】ラベル・T.S:全角スペース入り期間ヘッダー)＋ハーネス本番忠実化(worksheetToGrid/cells経路フォールバック)でWARN 7→0件。sync_extractorsのTS変換4バグ修正(オブジェクト型戻り値/string[][]/as union/文字列内!破壊)

---
