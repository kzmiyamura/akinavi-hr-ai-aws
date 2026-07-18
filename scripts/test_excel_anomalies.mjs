#!/usr/bin/env node
/**
 * test_excel_anomalies.mjs — Excel解析の「想定異常系」合成テスト
 *
 * 経歴書テンプレートは自由形式のため、実ファイルで遭遇する前に想定できる
 * 異常パターンを合成グリッドで作り込み、抽出ロジックの頑健性を回帰保証する。
 * 実xlsxを使わない（PIIゼロ・高速・fixture管理不要）。
 *
 * 使い方:
 *   node scripts/test_excel_anomalies.mjs        # 全ケース実行
 *   node scripts/test_excel_anomalies.mjs -v     # 期待値と実測を全件表示
 *
 * 追加ルール:
 *   - 新しい異常フォーマットを実データで発見したら、まずここにケースを足して
 *     FAIL を確認 → index.ts を修正 → PASS を確認（テストファースト）
 *   - index.ts 変更後は node scripts/sync_extractors.mjs を忘れずに
 */
import { extractSkillYearsFromSheetData } from './_extractors.gen.mjs'

const verbose = process.argv.includes('-v')
let pass = 0
let fail = 0
const failures = []

/** スキルキーのみ比較（_totalProjectMonths 等の内部キーは spec.internal で個別指定） */
function t(label, data, expectSkills, opts = {}) {
  const r = extractSkillYearsFromSheetData(data)
  const got = {}
  const gotInternal = {}
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('_')) gotInternal[k] = v
    else got[k] = v
  }
  let ok = Object.keys(got).length === Object.keys(expectSkills).length
    && Object.entries(expectSkills).every(([k, v]) => (typeof v === 'function' ? v(got[k]) : got[k] === v))
  if (ok && opts.internal) {
    ok = Object.entries(opts.internal).every(([k, v]) => (typeof v === 'function' ? v(gotInternal[k]) : gotInternal[k] === v))
  }
  if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`, JSON.stringify(got)) }
  else {
    fail++
    failures.push(label)
    console.log(`  FAIL ${label}`)
    console.log(`       expect: ${JSON.stringify(expectSkills)}${opts.internal ? ' internal:' + JSON.stringify(opts.internal) : ''}`)
    console.log(`       got   : ${JSON.stringify(got)} internal:${JSON.stringify(gotInternal)}`)
  }
}

const H = ['No', '開始年月', '案件', '終了年月', '使用言語']

console.log('=== A. ヘッダー表記ゆれ ===')
t('A1: 全角ASCII複合ヘッダー（ＯＳ/ＤＢ/言語）',
  [['No', '開始年月', '案件', '終了年月', 'ＯＳ/ＤＢ/言語'], ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 })
t('A2: 改行入りヘッダー（作業\\n月数）+ 純整数月数',
  [['No', '作業\n月数', '案件', '使用言語'], ['1', '18', 'X', 'Java']],
  { Java: 18 })
t('A3: スペース入りヘッダー（言　　語）',
  [['No', '開始年月', '案件', '終了年月', '言　　語'], ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 })
t('A4: 表題行の下にヘッダーがある',
  [['職務経歴書', '', '', '', ''], ['氏名: X', '', '', '', ''], H, ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 })

console.log('=== B. 期間表現のバリエーション ===')
t('B1: Excelシリアル日付（43922〜44652 = 2020/4〜2022/4）',
  [H, ['1', '43922', 'X', '44652', 'Java']],
  { Java: 25 })
t('B2: US日付形式（4/1/20〜3/1/22）',
  [H, ['1', '4/1/20', 'X', '3/1/22', 'Java']],
  { Java: 24 })
t('B3: ドット区切り日付範囲が期間列に（2020.04 ～ 2022.03）',
  [['No', '期間', '案件', '使用言語'], ['1', '2020.04 ～ 2022.03', 'X', 'Java']],
  { Java: 24 })
t('B4: 終了が「現在」（動的計算）',
  [['No', '期間', '案件', '使用言語'], ['1', '2020/04〜現在', 'X', 'Java']],
  { Java: (v) => {
    const now = new Date()
    const expect = (now.getFullYear() - 2020) * 12 + (now.getMonth() + 1 - 4) + 1
    return v === expect
  } })
t('B5: 期間逆転（終了<開始）→ 行スキップでスキルなし',
  [H, ['1', '2022/03', 'X', '2020/04', 'Java']],
  {})
t('B6: マルチライン期間セル（2025年3月\\n～\\n2026年2月）',
  [['No', '期間', '案件', '使用言語'], ['1', '2025年3月\n～\n2026年2月', 'X', 'Java']],
  { Java: 12 })
t('B7: 2桁年（20/04〜22/03）',
  [H, ['1', '20/04', 'X', '22/03', 'Java']],
  { Java: 24 })
t('B8: 令和の元号年（R2/04〜R4/03 = 2020/04〜2022/03）',
  [H, ['1', 'R2/04', 'X', 'R4/03', 'Java']],
  { Java: 24 })
t('B9: 平成の元号年（H30/4〜H31/3 = 2018/04〜2019/03）',
  [H, ['1', 'H30/4', 'X', 'H31/3', 'Java']],
  { Java: 12 })
t('B10: 漢字元号（令和2年4月〜令和4年3月）',
  [H, ['1', '令和2年4月', 'X', '令和4年3月', 'Java']],
  { Java: 24 })

console.log('=== C. 構造の異常 ===')
t('C1: 並行案件はマージ（完全重複）',
  [H, ['1', '2020/04', 'X', '2022/03', 'Java'], ['2', '2020/04', 'Y', '2022/03', 'Java']],
  { Java: 24 })
t('C2: 部分重複は重なりを1回だけ',
  [H, ['1', '2019/04', 'X', '2021/03', 'Java'], ['2', '2020/04', 'Y', '2022/03', 'Java']],
  { Java: 36 })
t('C3: マージセルで同一No.が複数行に展開（No.列が別位置）',
  [['項目', 'No', '開始年月', '終了年月', '使用言語'],
   ['a', '1', '2020/04', '2022/03', 'Java'],
   ['b', '1', '2020/04', '2022/03', 'Java']],
  { Java: 24 })
t('C4: 空行・区切り行が混ざる',
  [H, ['1', '2020/04', 'X', '2022/03', 'Java'], ['', '', '', '', ''], ['2', '2022/04', 'Y', '2023/03', 'SQL']],
  { Java: 24, SQL: 12 })
t('C5: 1スキル40年超（480ヶ月超）は異常値として破棄',
  [H, ['1', '1980/01', 'X', '2026/01', 'COBOL']],
  {})
t('C6: 未来だけの期間（2030/01〜2031/12）も月数としては通る（値の妥当性はfilter対象外）',
  [H, ['1', '2030/01', 'X', '2031/12', 'Java']],
  { Java: 24 })

console.log('=== D. スキルセルの異常 ===')
t('D1: カテゴリラベル形式（言語：Java/SQL）は値だけ抽出',
  [H, ['1', '2020/04', 'X', '2022/03', '言語　：　Java/SQL']],
  { Java: 24, SQL: 24 })
t('D2: 区切り混在（改行・読点・カンマ）',
  [H, ['1', '2020/04', 'X', '2022/03', 'Java\nPython、Go,TypeScript']],
  { Java: 24, Python: 24, Go: 24, TypeScript: 24 })
t('D3: ハイフンのみのセルはスキルにしない',
  [H, ['1', '2020/04', 'X', '2022/03', '-']],
  {})
t('D4: 純数字のスキル名（行番号の誤混入）は除外',
  [H, ['1', '2020/04', 'X', '2022/03', '123']],
  {})
t('D5: 金額（105万）をスキルと誤認しない',
  [H, ['1', '2020/04', 'X', '2022/03', '105万']],
  {})
t('D6: 工程語（要件定義）をスキルと誤認しない',
  [H, ['1', '2020/04', 'X', '2022/03', '要件定義']],
  {})
t('D7: 数式エラー（#REF!）を除外',
  [H, ['1', '2020/04', 'X', '2022/03', '#REF!']],
  {})
t('D8: 括弧の対応が崩れた断片（(CentOS）を除外',
  [H, ['1', '2020/04', 'X', '2022/03', '(CentOS']],
  {})
t('D9: 日付範囲がスキル名として紛れ込んだら除外',
  [H, ['1', '2020/04', 'X', '2022/03', '2022/2～2022/9']],
  {})
t('D10: 同一行の言語セルとFW列に同じスキル → 二重カウントしない',
  [['No', '開始年月', '案件', '終了年月', '使用言語', 'FW'],
   ['1', '2020/04', 'X', '2022/03', 'Java', 'Java']],
  { Java: 24 })

console.log('=== E. 総経験の内部キー ===')
t('E1: 上部の「IT経験 7年」宣言 → _totalProjectMonths=84',
  [['IT経験', '7年', '', '', ''], H, ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 }, { internal: { _totalProjectMonths: 84 } })
t('E2: 凡例（◎＝業務経験1年以上）を経験宣言と誤認しない',
  [['凡例：◎＝業務経験1年以上', '', '', '', ''], H, ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 }, { internal: { _totalProjectMonths: 24 } })

console.log('=== F. スキル一覧型（Method 2/3） ===')
t('F1: スキル一覧型（Java | 5年）',
  [['スキル', '経験'], ['Java', '5年'], ['SQL', '3年']],
  { Java: 60, SQL: 36 })
t('F2: 経験年数列が数値のみ（Java | 5）',
  [['スキル名', '経験年数'], ['Java', '5'], ['SQL', '3']],
  { Java: 60, SQL: 36 })

console.log(`\n📊 ${pass} passed / ${fail} failed（全${pass + fail}ケース）`)
if (fail > 0) console.log('FAILED:', failures.join(' | '))
process.exit(fail > 0 ? 1 : 0)
