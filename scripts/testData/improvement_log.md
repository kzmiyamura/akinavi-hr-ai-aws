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
