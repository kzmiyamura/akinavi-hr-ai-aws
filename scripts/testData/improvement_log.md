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
