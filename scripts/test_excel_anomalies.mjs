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
import { extractSkillYearsFromSheetData, scoreSkillQuality, gridToJsonRows, extractSkillYearsFromSheetJson, filterSkillYears, extractSkillYearsFromBodyText, cellToText } from './_extractors.gen.mjs'

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

t('B11: 半角カナの期間（73ｶ月）',
  [['No', '期間', '案件', '使用言語'], ['1', '73ｶ月', 'X', 'COBOL']],
  { COBOL: 73 })
t('B12: 1990年代のExcelシリアル日付（32021〜34213 = 1987/09〜1993/09）',
  [H, ['1', '32021', 'X', '34213', 'COBOL']],
  { COBOL: 73 })
t('B13: 縦積みシリアル日付（F.K型: 開始が本行col1・終了が次行col1・期間テキストなし）',
  [['No', '開発期間', 'プロジェクト名', '', '', '', '言語・ツール'],
   ['1', '36617', '健康管理システム', '', '', '', 'SQL'],
   ['', '39052', '', '', '', '', ''],
   ['', '15名', '', '', '', '', '']],
  { SQL: 81 })

t('B14: 空白入り日付（mammoth由来「2008 年 5 月 ～ 2010 年 4 月」）',
  [['No', '期間', '案件', '使用言語'], ['1', '2008 年 5 月 ～ 2010 年 4 月', 'X', 'Java']],
  { Java: 24 })
t('B15: 丸数字の行番号（①②）+ 開発環境列（K.J型）',
  [['No', '期間', '担当業務', '開発環境等'],
   ['①', '2012/06 ～ 2013/02', 'ゲーム開発', 'CakePHP2\nMySQL\nLinux'],
   ['②', '2013/03 ～ 2013/12', 'サイト開発', 'WordPress\nPHP\nApache']],
  { CakePHP2: 9, MySQL: 9, Linux: 9, WordPress: 10, PHP: 10, Apache: 10 })

t('C14: 行番号セルが分割セル日付の結合に混入しない（N.J型: "3"+"2023"→"32023"誤爆）',
  [['No', '', '期間', '', '', '業務内容', '使用言語'],
   ['3', '', '2023', '年', '8', '案件C', 'HTML5'],
   ['', '', '2024', '年', '3', '', '']],
  { HTML5: (v) => v !== undefined && v > 0 && v <= 24 })  // 誤爆すると1987年扱いで巨大な値になっていた
t('C13: 「項番」を行番号列と認識し、継続行の終了日だけの行を二重計上しない（S.Y型）',
  [['項番', '期間', '業務内容', '言語'],
   ['1', '2019/06', '案件A', 'Java'],
   ['', '2021/09', '', '']],
  { Java: 28 })  // 二重計上バグがあると56（2倍）になっていた
t('D16: Server:/PC: カテゴリラベルもコロン後の値だけ抽出する（F.K型）',
  [H, ['1', '2020/04', 'X', '2022/03', 'Server：日立、DELL・Windows\nPC：各ベンダー・Windows98']],
  { '日立': 24, DELL: 24, Windows: 24, '各ベンダー': 24, Windows98: 24 })
t('A6: 長文の自由記述セルに「言語」等の部分文字列が含まれてもヘッダー列と誤認しない（H.M型）',
  [['役割', '業務内容'],
   ['SE', '担当業務は要件定義から使用言語の選定まで多岐にわたり、環境構築のフェーズでは複数のOSに対応した'],
   ['PG', 'サーバの言語仕様を精査し、DBとのAPI連携部分を担当した。プロジェクト規模は約30人月']],
  {})  // 長文が誤って言語列として採用されると、行全体がコロン区切りのゴミキーになっていた
t('A5: 「開発環境」グループ見出しより「言語」の具体列名を優先する（H.R型）',
  [['No', '開発環境', '', '', '', '', ''],
   ['No', '期間', '機種', 'OS', '言語', 'DB', 'ツール'],
   ['1', '2020/04〜2021/03', 'Win10', 'Win10', 'Java\nPython', 'Oracle', 'Git']],
  { Java: 12, Python: 12, Git: 12 })  // 「開発環境」列(機種=Win10)ではなく「言語」+「ツール」列を採用すべき
t('B17: 日付でない小数（38.53333333333333）を年月と誤読しない（H.R型: 未来へ暴走するバグ）',
  [H, ['1', '2009/04', 'X', '38.53333333333333', 'Java']],
  {})  // 誤読すると398ヶ月(33年)の架空の未来日付になっていた。有効な期間なしとして扱うのが正
t('B18: 月が13以上の無効な「年.月」風文字列は日付として採用しない',
  [H, ['1', '2020/04', 'X', '2020.53', 'Java']],
  {})
t('B16: 和暦の元年（平成元年4月～平成2年3月 = 1989/04〜1990/03）',
  [['No', '期間', '案件', '使用言語'], ['1', '平成元年4月～平成2年3月', 'X', 'COBOL']],
  { COBOL: 12 })
t('C8: 日付列が離れている（No|期間|開始serial|-|終了serial|…|言語/FW）RH型',
  [['契約先', 'NO', '期間', '', '', '', '内容', '言語/FW'],
   ['T', '1', '45992', '-', '', '46142', '法務システム', 'TypeScript\nRuby'],
   ['T', '2', '45658', '-', '', '45900', '別件', 'Go\nReact']],
  { TypeScript: 5, Ruby: 5, Go: 8, React: 8 })
t('C9: No列なし+終了が「現在」+期間テキスト別行（O.M型）',
  [['期間', '', '', '', '業務内容', '役割', '使用言語'],
   ['', '44774', '-', '現在', '■SDK開発', 'SE', 'Swift\nObjective-C'],
   ['', '3年8ヶ月', '', '', 'детали', '', ''],
   ['', '45536', '-', '45627', '■PoC開発', 'SE', 'Kotlin\nJava'],
   ['', '4ヶ月', '', '', '', '', '']],
  { Swift: (v) => v >= 40, 'Objective-C': (v) => v >= 40, Kotlin: 4, Java: 4 })
t('C10: ブロック見出しが「番号+期間ラベル+プロジェクト名」形式（B.S型）',
  [['1', '期間', '', '', '', '【プロジェクト名】', '', '環境・使用ソフト'],
   ['', '46082', '', '', '', '建設業システム', '', 'Windows11'],
   ['', '～', '', '', '', '', '', 'REDMINE'],
   ['', '46142', '', '', '', '', '', 'Slack'],
   ['2', '期間', '', '', '', '【プロジェクト名】', '', '環境・使用ソフト'],
   ['', '45870', '', '', '', '不動産テック', '', 'GitHub'],
   ['', '～', '', '', '', '', '', 'Slack'],
   ['', '46048', '', '', '', '', '', 'JIRA']],
  { Windows11: (v) => v >= 2 && v <= 4, REDMINE: (v) => v >= 2 && v <= 4,
    Slack: (v) => v >= 5 && v <= 12, GitHub: (v) => v >= 5 && v <= 8, JIRA: (v) => v >= 5 && v <= 8 })

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

t('C11: 年・月が別セルに分割（M.N型: [2026][年][4][月] + 縦積み終了）',
  [['', '開発期間', '', '', '', '業務内容', '環境・言語'],
   ['', '2026', '年', '4', '月', 'PET-CT制御開発', '【言語】\nVC++\nC#\nWin32API'],
   ['', '', '～', '', '', '', ''],
   ['', '2026', '年', '6', '月', '', '']],
  { 'VC++': 3, 'C#': 3, Win32API: 3 })
t('C12: 期間列が遠い列で縦積み+現在終了（K.I型）',
  [['No', '', '業務名', '言語/ツール等', '', '', '', '', '', '', '作業期間'],
   ['1', '', 'AI講座', 'n8n\nGemini\nSlack', '', '', '', '', '', '', '46023'],
   ['', '', '', '', '', '', '', '', '', '', '～'],
   ['', '', '', '', '', '', '', '', '', '', '現在']],
  { n8n: (v) => v >= 5, Gemini: (v) => v >= 5, Slack: (v) => v >= 5 })

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

t('D11: 末尾コロンのラベル残骸（能力指標：/期間：）を除外',
  [H, ['1', '2020/04', 'X', '2022/03', '能力指標：\n期間：']],
  {})
t('D12: 会社名・組織名（株式会社〜/〜法律事務所）をスキルと誤認しない',
  [H, ['1', '2020/04', 'X', '2022/03', '株式会社クロノス\n藍和法律事務所']],
  {})
t('D13: 勤務形態・単価レンジ（フルリモート/常駐可/88-93/応相談）を除外',
  [H, ['1', '2020/04', 'X', '2022/03', 'フルリモート\n常駐可\n88-93\n応相談\n通勤60分程度以内']],
  {})
t('D14: リモートデスクトップは実スキルとして残す',
  [H, ['1', '2020/04', 'X', '2022/03', 'リモートデスクトップ\nVBA\nSQL']],
  { 'リモートデスクトップ': 24, VBA: 24, SQL: 24 })
t('D15: 文章断片（読点入り）・＜見出し＞を除外',
  [H, ['1', '2020/04', 'X', '2022/03', '運用・保守から参画し、その後移行\n＜担当業務＞\nJava']],
  { Java: 24 })

console.log('=== E. 総経験の内部キー ===')
t('E1: 上部の「IT経験 7年」宣言 → _totalProjectMonths=84',
  [['IT経験', '7年', '', '', ''], H, ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 }, { internal: { _totalProjectMonths: 84 } })
t('E2: 凡例（◎＝業務経験1年以上）を経験宣言と誤認しない',
  [['凡例：◎＝業務経験1年以上', '', '', '', ''], H, ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 }, { internal: { _totalProjectMonths: 24 } })

t('E3: 経路記録 — プロジェクト経歴型は _extractMethod=10',
  [H, ['1', '2020/04', 'X', '2022/03', 'Java']],
  { Java: 24 }, { internal: { _extractMethod: 10 } })
t('E4: 経路記録 — KVブロック型は _extractMethod=17',
  [['No.', '', '期間', '', '内容'],
   ['1', '', '2023/01', '2023/12', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  { PHP: 12, MySQL: 12, Linux: 12 }, { internal: { _extractMethod: 17 } })
t('E5: 経路記録 — 近接探索型（最後の受け皿）は _extractMethod=20',
  [['スキル', '経験'], ['Java', '5年'], ['SQL', '3年']],
  { Java: 60, SQL: 36 }, { internal: { _extractMethod: 20 } })

console.log('=== F. スキル一覧型（Method 2/3） ===')
t('F1: スキル一覧型（Java | 5年）',
  [['スキル', '経験'], ['Java', '5年'], ['SQL', '3年']],
  { Java: 60, SQL: 36 })
t('F2: 経験年数列が数値のみ（Java | 5）',
  [['スキル名', '経験年数'], ['Java', '5'], ['SQL', '3']],
  { Java: 60, SQL: 36 })

console.log('=== G. KVブロック型（Method 1.7・S.I型） ===')
const BH = ['No.', '', '期間', '', '内容']
t('G1: 日付ペア+環境ラベル下のスキル（【言語】見出しは除去）',
  [BH,
   ['1', '', '2023/01', '2023/05', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', '【言語】\nPHP\nSQL\n【OS】\nLinux', '', ''],
   BH,
   ['2', '', '2023/06', '2024/05', '案件B'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL', '', '']],
  { PHP: 17, SQL: 5, Linux: 5, MySQL: 12 })
t('G2: ブロック期間が重複 → スキルは和集合',
  [BH,
   ['1', '', '2023/01', '2023/12', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', ''],
   BH,
   ['2', '', '2023/06', '2024/05', '案件B'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  { PHP: 17, MySQL: 17, Linux: 17 })
t('G3: 日付なし・期間テキスト（0年10ヶ月）フォールバック',
  [BH,
   ['1', '', '', '', '案件A'],
   ['', '', '0年10ヶ月', '', ''],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  { PHP: 10, MySQL: 10, Linux: 10 })
t('G4: 実スキル3件未満なら採用しない（誤発動ガード）',
  [BH,
   ['1', '', '2023/01', '2023/05', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP', '', '']],
  {})
t('G6: 終了が「現在」のブロック（開始日付+現在）',
  [BH,
   ['1', '', '2026/01', '現在', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  { PHP: (v) => v >= 6 && v <= 8, MySQL: (v) => v >= 6 && v <= 8, Linux: (v) => v >= 6 && v <= 8 })
t('G7: 期間が1セルの日付範囲（2023/01～2023/05）',
  [BH,
   ['1', '', '2023/01～2023/05', '', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  { PHP: 5, MySQL: 5, Linux: 5 })
t('G8: 期間列に開始・終了が縦積み（別行）',
  [BH,
   ['1', '', '2023/01', '', '案件A'],
   ['', '', '～', '', ''],
   ['', '', '2023/05', '', ''],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  { PHP: 5, MySQL: 5, Linux: 5 })
t('G9: 環境ラベルと値が同一セル（環境：PHP/MySQL/Linux）',
  [BH,
   ['1', '', '2023/01', '2023/05', '案件A'],
   ['', '', '環境：PHP/MySQL/Linux', '', '']],
  { PHP: 5, MySQL: 5, Linux: 5 })
t('G10: ブロック期間が逆転（終了<開始）→ そのブロックは不採用',
  [BH,
   ['1', '', '2023/05', '2023/01', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', 'PHP\nMySQL\nLinux', '', '']],
  {})
t('G11: ブロックごとに期間列の位置が違う',
  [['No.', '期間', '', '', '内容'],
   ['1', '2023/01', '2023/06', '', '案件A'],
   ['', '環境', '', '', ''],
   ['', 'PHP\nMySQL\nLinux', '', '', ''],
   ['No.', '', '期間', '', '内容'],
   ['2', '', '2023/07', '2023/12', '案件B'],
   ['', '', '環境', '', ''],
   ['', '', 'Go\nRedis\nDocker', '', '']],
  { PHP: 6, MySQL: 6, Linux: 6, Go: 6, Redis: 6, Docker: 6 })
t('G5: ラベル残骸・注記・半角カナはスキルにしない',
  [BH,
   ['1', '', '2023/01', '2023/12', '案件A'],
   ['', '', '環境', '', ''],
   ['', '', '能力指標：\n(遠隔操作用)\nﾌﾘｶﾞﾅ\nPHP\nMySQL\nLinux', '', '']],
  { PHP: 12, MySQL: 12, Linux: 12 })

console.log('=== G2. 期間|業務内容 繰り返し表型（Method 1.8・M.K型のWord経歴書） ===')
t('G12: 期間|業務内容ヘッダーが案件ごとに繰り返し・スキルは本文中の技術語',
  [['期間', '業務内容'],
   ['2019/01～2023/06', 'F株式会社でのキッティング業務。Windows、Excel、TeraTermを使用'],
   ['期間', '業務内容'],
   ['2023/10～2024/09', 'M株式会社。Linux サーバの構築。Apache と MySQL の運用'],
  ],
  { Windows: 54, Excel: 54, TeraTerm: 54, Linux: 12, Apache: 12, MySQL: 12 })
t('G13: 繰り返し表だが技術語が乏しい → スキルは作らず総経験のみ（誠実な退化）',
  [['期間', '業務内容'],
   ['2019/01～2023/06', '倉庫内の入出荷管理'],
   ['期間', '業務内容'],
   ['2023/10～2024/09', '配送伝票の作成業務'],
  ],
  {}, { internal: { _totalProjectMonths: 66 } })
t('G14: ヘッダーが1回だけなら発動しない（既存の型と誤判定しない）',
  [['期間', '業務内容'],
   ['2019/01～2023/06', 'Windows、Excel を使用']],
  {})

t('G15: 開発期間ヘッダの繰り返し表+環境・言語列（IS型Word）',
  [['開発期間', '業務内容', '担当フェーズ', '環境・言語　等', '職位'],
   ['2021年10月～2022年9月', 'データ基盤開発', '要件定義', '【DBツール】GCP・BigQuery', 'リーダー'],
   ['開発期間', '業務内容', '担当フェーズ', '環境・言語　等', '職位'],
   ['2021年7月〜2021年9月', 'データ分析', '分析', 'BigQuery・Python', 'メンバー']],
  { GCP: 12, BigQuery: (v) => v >= 12 && v <= 15, Python: 3 })
t('G16: セル内テキストに期間が埋め込まれた表（H.M型: 役割(期間)|内容）',
  [['役割', '内容'],
   ['PM（プロジェクト要員 2019年4月〜2020年3月）', 'FX取引システム開発。Java、Oracle を使用'],
   ['スクラムマスター（2020年4月〜2020年9月）', 'ポータルサイト開発。AWS、Docker'],
   ['コンサルタント（2021年1月〜2021年6月）', 'IoT基盤構想。Azure 利用'],
   ['営業（2022年1月〜2022年3月）', '（技術要素なし）'],
   ['PM補助（2022年4月〜2022年6月）', 'PowerBI でのレポート作成']],
  { Java: 12, Oracle: 12, AWS: 6, Docker: 6, Azure: 6, PowerBI: 3 })

console.log('=== H. 品質スコア（方式勝者の選択基準） ===')
{
  const master = new Set(['java', 'aws', 'python'])
  const sc = (label, ok) => {
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}`) }
  }
  sc('H1: マスタ一致キーは3点・不一致は1点',
    scoreSkillQuality({ Java: 24, 独自ツール: 12 }, master) === 4)
  sc('H2: マスタ未取得（null）は件数に退化',
    scoreSkillQuality({ Java: 24, 独自ツール: 12 }, null) === 2)
  sc('H3: 内部キー（_totalProjectMonths等）は数えない',
    scoreSkillQuality({ Java: 24, _totalProjectMonths: 60 }, master) === 3)
  sc('H4: ゴミ5件(1点×5) はマスタ一致2件(3点×2)+1件(1点) に勝てない',
    scoreSkillQuality({ a1: 1, a2: 1, a3: 1, a4: 1, a5: 1 }, master)
      < scoreSkillQuality({ Java: 24, AWS: 12, 独自: 6 }, master))
  sc('H5: 照合はスペース・大小文字を無視',
    scoreSkillQuality({ 'JAVA ': 24 }, new Set(['java'])) === 3)
}

console.log('=== I. Unified 方式7（文章行の期間×技術語・narrative Word） ===')
{
  const { extractSkillYearsUnified } = await import('./_extractors.gen.mjs')
  const tu = (label, grid, extra, expect) => {
    const r = extractSkillYearsUnified(grid, extra)
    const got = Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')))
    const ok = Object.keys(got).length === Object.keys(expect).length
      && Object.entries(expect).every(([k, v]) => (typeof v === 'function' ? v(got[k]) : got[k] === v))
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       expect: ${JSON.stringify(expect)}\n       got   : ${JSON.stringify(got)} method=${r._extractMethod}`) }
  }
  tu('I1: 段落文章の「期間（…）会社にて…技術」行から抽出',
    [[]],
    ['2007年6月〜2009年7月（2年1か月）某ERP開発会社にて固定資産モジュールをJavaとOracleで開発',
     '2009年8月〜2010年7月（1年）物流システムの保守。PostgreSQLとSpringを使用',
     '2010年8月〜2011年7月 社内SE。ExcelVBAでツール作成'],
    { Java: 26, Oracle: 26, PostgreSQL: 12, Spring: 12, ExcelVBA: 12 })
  tu('I2: 期間行が2行以下なら発動しない（誤爆防止）',
    [[]],
    ['2007年6月〜2009年7月 Javaで開発'],
    {})
}

t('F3: 複合ヘッダー「ツール・言語・環境」+「経験期間」の保有スキル一覧（M.K型）',
  [['分類', 'ツール・言語・環境', '経験期間'],
   ['言語', 'Java', '14年'],
   ['', 'VBA', '0.5年'],
   ['DB', 'Oracle', '5年']],
  { Java: 168, VBA: 6, Oracle: 60 })

console.log('=== J. 方式1（列名ベース・gridToJsonRows）の期間列誤読 ===')
{
  const tj = (label, grid, ok) => {
    const r = extractSkillYearsFromSheetJson(gridToJsonRows(grid))
    const cond = ok(r)
    if (cond) { pass++; if (verbose) console.log(`  PASS ${label}`, JSON.stringify(r)) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       got: ${JSON.stringify(r)}`) }
  }
  // ヘッダー行の一部セルが空だと、gridToJsonRows は該当列を丸ごと落とす（列位置マッピングのため）。
  // 実データで「期間」ヘッダーの隣に無題の日付列2本（開始・終了serial）があり、
  // 「期間」列自体には行番号(1,2,3…)しか入っていないシートが存在した。
  // rawPeriodIsIntMonths ヒューリスティックがこの行番号を「月数」と誤読し、
  // Java(実際は複数案件で計200ヶ月超)が28ヶ月という桁違いの過小評価になっていた（I.Sさん実害）
  tj('J1: 期間列に行番号(1,2,3)が入り、真の日付は無題列で失われる → 誤った月数を作らない',
    [['期間', '', '', '業務内容', '使用言語'],
     ['1', '2020/04', '2020/12', '案件A', 'Java'],
     ['2', '2021/01', '2021/12', '案件B', 'Java'],
     ['3', '2022/01', '2022/06', '案件C', 'Java']],
    (r) => r.Java === undefined || r.Java > 9)  // 行番号合算(1+2+3=6ヶ月)のような過小値は不可
  tj('J2: 正規の月数列（真に1,2,3ヶ月で全て異なる案件）は従来どおり信頼する',
    [['期間', '業務内容', '使用言語'], ['1', '短期A', 'Ruby'], ['5', '中期B', 'Ruby']],
    (r) => r.Ruby === 6)
}

console.log('=== K. looksLikeRosterName（1人スキルシートを名簿と誤検出しない） ===')
{
  const { looksLikeRosterName } = await import('./_extractors.gen.mjs')
  const kr = (label, s, expect) => {
    const got = looksLikeRosterName(s)
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       looksLikeRosterName(${JSON.stringify(s)})=${got} expect=${expect}`) }
  }
  // スキルシートのカテゴリ見出しは人名ではない（Y.M_沼津.xlsx 実害: データベース/ネットワークが人材化）
  kr('K1: データベースは人名でない', 'データベース', false)
  kr('K2: ネットワークは人名でない', 'ネットワーク', false)
  kr('K3: サーバーは人名でない', 'サーバー', false)
  kr('K4: インフラは人名でない', 'インフラ', false)
  kr('K5: クラウドは人名でない', 'クラウド', false)
  kr('K6: セキュリティは人名でない', 'セキュリティ', false)
  // 正規の人名は従来どおり通す（回帰防止）
  kr('K7: イニシャル Y.M は人名', 'Y.M', true)
  kr('K8: OH は人名', 'OH', true)
  kr('K9: カタカナ氏名(スペース区切り)は人名', 'タナカ タロウ', true)
  kr('K10: 外国人名 グエン は人名', 'グエン', true)
  // 実害(2026-08-05 eyebrains): 全角スペース入り見出し「年　数」がすり抜けて人名登録された
  kr('K11: 年　数(全角スペース入り見出し)は人名でない', '年　数', false)
  kr('K12: 期　間は人名でない', '期　間', false)
  kr('K13: 学　歴は人名でない', '学　歴', false)
  // 実害(2026-08-08 ブライトスター): 職務経歴書の学歴欄・スキル見出しがROSTER行として
  // 人材登録された（早稲田大学/ＯＳ/ＤＢ/WEB 等がprodに量産）
  kr('K14: 早稲田大学は人名でない', '早稲田大学', false)
  kr('K15: 愛知県立刈谷工科高等学校（三年制）は人名でない', '愛知県立刈谷工科高等学校（三年制）', false)
  kr('K16: 尚絅大学（4年制） 卒業は人名でない', '尚絅大学（4年制） 卒業', false)
  kr('K17: 大学卒業は人名でない', '大学卒業', false)
  kr('K18: 修士・専修大学大学院は人名でない', '修士・専修大学大学院', false)
  kr('K19: ＯＳ(全角)は人名でない', 'ＯＳ', false)
  kr('K20: ＤＢ(全角)は人名でない', 'ＤＢ', false)
  kr('K21: ＷＥＢ(全角)は人名でない', 'ＷＥＢ', false)
  kr('K22: DB(半角2文字見出し)は人名でない', 'DB', false)
  kr('K23: NW(半角2文字見出し)は人名でない', 'NW', false)
  // 学歴の略記（大卒/高卒等）も人名ではない（「卒業」を含まないためすり抜けた実害）
  kr('K26: 大卒は人名でない', '大卒', false)
  kr('K27: 高卒は人名でない', '高卒', false)
  kr('K28: 大卒（4年制）は人名でない', '大卒（4年制）', false)
  kr('K29: 院卒は人名でない', '院卒', false)
  // 実害(2026-08-10 トリニタス): 個人スキルシートの案件表「勤務地」列が氏名列と誤認され、
  // 勤務地の駅名（大手町・築地・泉岳寺…）が人材として量産された
  kr('K30: 勤務地は人名でない', '勤務地', false)
  kr('K31: 場所は人名でない', '場所', false)
  kr('K32: 就業場所は人名でない', '就業場所', false)
  kr('K33: 常駐先は人名でない', '常駐先', false)
  // 回帰防止: 「学」を含む正規の人名・イニシャルは通す
  kr('K24: 中村 学 は人名', '中村 学', true)
  kr('K25: Tanaka Taro は人名（全角化しても弾かない）', 'Tanaka Taro', true)
  // 実害(2026-08-11 Trinitas): 経歴書の顧客欄セルが氏名列に並び、取引先企業名の
  // 幽霊人材が11件量産された（日新火災・野村証券・中外製薬…→隔離）
  kr('K34: 顧客は人名でない', '顧客', false)
  kr('K35: 顧客名は人名でない', '顧客名', false)
}

console.log('=== K2. personAttrScore（名簿行を人材として起こす裏付け・構造対策） ===')
{
  const { personAttrScore } = await import('./_extractors.gen.mjs')
  const ps = (label, text, expectPromote) => {
    const got = personAttrScore(text) >= 2
    if (got === expectPromote) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       score=${personAttrScore(text)} promote=${got} expect=${expectPromote}`) }
  }
  // 経歴書の案件表の行（人の属性が無い）→ 人材として起こしてはいけない
  ps('K2-1: 案件表の行（勤務地・期間・業務内容）は人材化しない',
    '【勤務地】大手町\n【期間】2020/04～2022/03\n【業務内容】バッチ設計・製造\n【役割】PG', false)
  ps('K2-2: 案件表の行（工程・環境）は人材化しない',
    '【勤務地】築地\n【工程】要件定義～テスト\n【環境】COBOL、DB2', false)
  // 本物の名簿行（人の属性が2種類以上）→ 人材として起こす
  ps('K2-3: 本物の名簿行（年齢・性別・単価）は人材化する',
    '【名前】JIN\n【性別】男\n【年齢】62\n【希望単価】58万円\n【所属】当社個人事業主', true)
  ps('K2-4: 最寄駅＋所属の名簿行も人材化する',
    '【名前】OMT\n【自宅最寄駅】JR根岸線 港南台駅\n【所属】当社契約社員', true)
  ps('K2-5: 単価と稼働だけでも人材化する',
    '【氏名】A.M\n【希望単金】60万\n【稼働開始】即日', true)
  // 属性1種のみ（境界）→ 起こさない
  ps('K2-6: 属性1種のみは人材化しない', '【勤務地】新宿\n【最寄駅】新宿駅', false)
}

console.log('=== K3. isOwnersResumeFile（本人の経歴書を名簿扱いしない・構造対策） ===')
{
  const { isOwnersResumeFile } = await import('./_extractors.gen.mjs')
  const r = (label, filename, bodyNames, expect) => {
    const got = isOwnersResumeFile(filename, bodyNames)
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       isOwnersResumeFile(${filename})=${got} expect=${expect}`) }
  }
  // 実害(2026-08-10 トリニタス): 本文1名(OMT)の経歴書が名簿と誤検出され駅名が人材化した
  r('K3-1: 本人名入りの経歴書は本人のもの', 'Skill_OMT_20260628.xlsx', ['OMT'], true)
  r('K3-2: 氏名入りの職務経歴書も本人のもの', '職務経歴書_S・R【清水】.xls', ['S・R'], true)
  r('K3-3: 全角/半角ゆれも一致とみなす', 'skill_ｏｍｔ.xlsx', ['OMT'], true)
  // 名簿ファイルは本人のものではない（=名簿として展開してよい）
  r('K3-4: 営業中一覧は名簿（本文人材名を含まない）', '営業中フリーランス一覧_2026.xlsx', ['MY'], false)
  r('K3-5: 連番ファイル名の名簿も名簿', '202686.xlsx', ['MY'], false)
  r('K3-6: 本文に人名が無ければ常に名簿扱い', 'Skill_OMT_20260628.xlsx', [], false)
  r('K3-7: 別人の経歴書は本人のものではない', 'Skill_ABC_20260628.xlsx', ['OMT'], false)
}

console.log('=== K4. stripInitialSuffix（氏名を3文字に切らない・#128） ===')
{
  const { stripInitialSuffix } = await import('./_extractors.gen.mjs')
  const s = (label, input, expect) => {
    const got = stripInitialSuffix(input)
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       stripInitialSuffix(${JSON.stringify(input)})=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`) }
  }
  // 実害(2026-08-10 #128): 英字4文字以上の氏名が全員3文字に切られた
  s('K4-1: tani（38歳・男性）は切らない', 'tani（38歳・男性）', 'tani（38歳・男性）')
  s('K4-2: Kengo（30歳／男性）は切らない', 'Kengo（30歳／男性）', 'Kengo（30歳／男性）')
  s('K4-3: Tanaka Taro は切らない', 'Tanaka Taro', 'Tanaka Taro')
  // 回帰防止: イニシャル＋説明文は従来どおり除去する
  s('K4-4: N.S＋説明文はイニシャルのみ', 'N.S顧客折衝～ベンダー調整可能なエンジニア！', 'N.S')
  s('K4-5: NK（補足）はイニシャルのみ', 'NK（長野に引っ越し予定）', 'NK')
  s('K4-6: K.Y＋全角空白＋説明文', 'K.Y　サブリーダーあり', 'K.Y')
  // 回帰防止: 年齢が続く場合は切らない（年齢・性別抽出のため）
  s('K4-7: A.S（25）男性 は切らない', 'A.S（25）男性', 'A.S（25）男性')
  s('K4-8: 短い名前はそのまま', 'M.M', 'M.M')
  // 実害(2026-08-16 フォスターネット): 性別が先に来る形式を説明文とみなして切り落とし、
  // 直後の年齢・性別抽出が全滅していた（18名中 年齢取得 0件）
  s('K4-9: K.H（男性/42歳）は切らない', 'K.H（男性/42歳）', 'K.H（男性/42歳）')
  s('K4-10: 半角括弧 T.I(男性/46歳) も切らない', 'T.I(男性/46歳)', 'T.I(男性/46歳)')
  s('K4-11: 全角空白入り S.Y (男性/52歳) も切らない', 'S.Y (男性/52歳)', 'S.Y (男性/52歳)')
  s('K4-12: 国籍が続く P.A(男性/27歳/来日16年) も切らない', 'P.A(男性/27歳/来日16年)', 'P.A(男性/27歳/来日16年)')
  // 回帰防止: 性別・年齢を含まない括弧書きは従来どおり除去する
  s('K4-13: NK（長野に引っ越し予定）は切る', 'NK（長野に引っ越し予定）', 'NK')
}

console.log('=== K5. 本文フィールドの誤抽出（#132/#133/#134） ===')
{
  const { extractNationalityMark, stationNameCandidates, extractWorkStyleNote } = await import('./_extractors.gen.mjs')
  const eq = (label, got, expect) => {
    const ok = JSON.stringify(got) === JSON.stringify(expect)
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`) }
  }
  // #134: 「※上記人材にマッチする案件〜」から「上記人」を国籍にしていた
  eq('K5-1: ※上記人材 は国籍でない', extractNationalityMark('※上記人材にマッチする案件情報がございましたら'), null)
  eq('K5-2: ※中国籍 は国籍', extractNationalityMark('氏名 A.B\n※中国籍'), '中国籍')
  eq('K5-3: ※ナイジェリア籍 は国籍', extractNationalityMark('※ナイジェリア籍（在日37年）'), 'ナイジェリア籍')
  eq('K5-4: ※日本人 は国籍（既知の国名のみ許可）', extractNationalityMark('※日本人'), '日本人')
  // #133: 「名鉄 犬山駅 ※愛知」から駅名を取れず都道府県が本文の別県に引きずられた
  eq('K5-5: 名鉄 犬山駅 ※愛知 から犬山を候補にする',
    stationNameCandidates('名鉄 犬山駅 ※愛知').includes('犬山'), true)
  eq('K5-6: JR根岸線 港南台駅 徒歩15分 から港南台を候補にする',
    stationNameCandidates('JR根岸線 港南台駅 徒歩15分').includes('港南台'), true)
  eq('K5-7: 路線名そのものは駅名候補にしない',
    stationNameCandidates('名鉄 犬山駅 ※愛知').includes('名鉄'), true)
  // #132: PR文を勤務形態として登録していた
  eq('K5-8: PR文は勤務形態にしない',
    extractWorkStyleNote('不明点を放置せず積極的に確認と相談を行う高いコミュニケーション力を持ち、リモート環境でも自発的に情報共有、連携が可能です', ''), null)
  eq('K5-9: 条件行は勤務形態として採用する',
    extractWorkStyleNote('週5日リモート可（出社は月1回程度）', ''), '週5日リモート可（出社は月1回程度）')
}

console.log('=== K7. isValidNationality / 勤務形態の長文除外（監査391件対応） ===')
{
  const { isValidNationality, extractWorkStyleNote } = await import('./_extractors.gen.mjs')
  const v = (label, input, expect) => {
    const got = isValidNationality(input)
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}: isValidNationality(${JSON.stringify(input)})=${got} expect=${expect}`) }
  }
  // 監査で検出された不正値（394件中109件）
  v('K7-1: 上記人 は国籍でない', '上記人', false)
  v('K7-2: 1人 は国籍でない', '1人', false)
  v('K7-3: 全国 は国籍でない', '全国', false)
  v('K7-4: 当該人 は国籍でない', '当該人', false)
  // 正しい国籍は通す
  v('K7-5: 中国籍 は国籍', '中国籍', true)
  v('K7-6: 日本人 は国籍', '日本人', true)
  v('K7-7: 外国籍 は国籍', '外国籍', true)
  v('K7-8: ナイジェリア籍 は国籍', 'ナイジェリア籍', true)
  // 勤務形態: 案件説明文・最寄駅行は採用しない
  const w = (label, input, expect) => {
    const got = extractWorkStyleNote(input, '')
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`) }
  }
  w('K7-9: 案件説明文は勤務形態にしない',
    '元請け企業配下にて客先常駐し、大手総合電機メーカーの社内システムにおける機能追加・改修業務に参画', null)
  w('K7-10: 最寄駅行は勤務形態にしない',
    '[最寄駅]　東京メトロ有楽町線等　要町駅　(東京都)　※常駐可(フル出社の場合、片道1時間程度までを希望)', null)
}

console.log('=== K6. deriveWorkStyleTag（例外的な出社は併用可にしない・#135） ===')
{
  const { deriveWorkStyleTag } = await import('./_extractors.gen.mjs')
  const w = (label, input, expect) => {
    const got = deriveWorkStyleTag(input)
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`) }
  }
  w('K6-1: フルリモート希望＋初週出社OK はリモート希望',
    'フルリモート希望　※初週や緊急時の出社は問題ございません', 'リモート希望')
  w('K6-2: フルリモート＋緊急時出社 はリモート希望', 'フルリモート（緊急時のみ出社）', 'リモート希望')
  w('K6-3: 週2出社は併用可のまま', 'リモート中心・週2日出社', '併用可')
  w('K6-4: 常駐可は常駐可のまま', '客先常駐可能', '常駐可')
  w('K6-5: フルリモートのみ はリモート希望', 'フルリモートのみ希望', 'リモート希望')
}

console.log('=== L. Method 1.7 KVブロック型: ラベル同列下方の文章セル混入（K.F型） ===')
// 実害: 「開発環境」ラベルの同列下方に「開発手法」「業務内容」ラベル→業務内容の文章セルが
// 並ぶテンプレートで、文章の断片（「また」「■主な業務内容」「‐ 不具合報告」等）が
// スキル年数キーとして大量混入した（JQIT K.F 実メール）。
// 同列下方の収集は別セクションラベルで打ち切り、文章セルを吸い込まないこと。
t('L1: 開発環境ラベル下方の業務内容文章を吸い込まない',
  [
    ['No.', '期間', '', '開始時期', '～', '終了時期', 'プロジェクト名'],
    ['1', '3年0カ月', '', '2023/1/1', '～', '2025/12/31', 'イベント評価'],
    ['', '開発環境', '', 'OS', 'Windows10', '', ''],
    ['', '', '', '言語', 'Java', '', ''],
    ['', '開発手法', '', '', '', '', ''],
    ['', '業務内容', '', '', '', '', ''],
    ['', '【業務内容】\n　チケット販売用特設サイト/イベント用特設サイトの運用/VerUPの検証を担当\n　‐ 不具合報告／対応推進\n　■主な業務内容の整理', '', '', '', '', ''],
  ],
  // 文章断片が全て除去されるとブロック内の実スキルは Java 1件のみ → Method 1.7 の
  // 「3件未満は誤発動とみなし委譲」ゲートにより不採用 = 空が正解（誠実な退化）。
  // ゴミ（開発手法/‐ 不具合報告/■主な業務内容… 等）が1件でも入ったら FAIL になる。
  {})

console.log('=== M. filterSkillYears: 期間表記・期間ヘッダー語のキー除外（K.F視覚エンジン実害） ===')
{
  const fy = (label, input, expectKeys) => {
    const got = Object.keys(filterSkillYears(input)).filter(k => !k.startsWith('_')).sort()
    const ok = JSON.stringify(got) === JSON.stringify(expectKeys.sort())
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       expect=${JSON.stringify(expectKeys)} got=${JSON.stringify(got)}`) }
  }
  // 実害: 視覚エンジンが期間セル「0年8カ月」・ヘッダー「終了時期」をスキルキーとして返した
  fy('M1: 複合期間表記キーを除外', { '0年8カ月': 108, 'Java': 24 }, ['Java'])
  fy('M2: 期間ヘッダー語キーを除外', { '終了時期': 108, '開始時期': 50, 'Python': 12 }, ['Python'])
  fy('M3: 単純年・月表記キーを除外', { '3年': 36, '8ヶ月': 8, 'AWS': 24 }, ['AWS'])
  fy('M4: 構造ヘッダー語キーを除外', { 'プロジェクト名': 40, 'チーム人数': 40, 'ポジション': 40, '管理・教育': 40, 'Go': 18 }, ['Go'])
  fy('M5: 正規スキルは通す（回帰）', { 'テスト設計': 36, 'テスト実行': 49, 'C言語': 60 }, ['C言語', 'テスト実行', 'テスト設計'])
  // 実害: K.F の Excel セル「QAエンジニア　経験年数」＋期間セルの組で
  // 見出し語連結キーがそのまま skillYears に保存された（2026-07-28 JQIT実メール）
  fy('M6: 見出し語連結キーはスキル名へ正規化', { 'QAエンジニア　経験年数': 60, '経験年数': 24 }, ['QAエンジニア'])
  fy('M7: 業務/実務経験年数サフィックスも正規化', { 'Java 業務経験年数': 36, 'Python実務経験年数': 24 }, ['Java', 'Python'])
  // 実害: prod実データに「経験年数：」「IT経験年数」「業界経験年数」「総経験年数」等の
  // 総経験ラベルキーが15件残存していた（旧コード産）。剥がし残骸（IT/総/業界）も出さないこと
  fy('M8: 総経験ラベルキーは丸ごと除外', { '経験年数：': 156, 'IT経験年数': 206, '業界経験年数': 180, '総経験年数': 252, 'Ruby': 12 }, ['Ruby'])
  // TMK実メール(2026-07-30): 技術経歴書のgrid抽出で混入した4クラスのゴミキー
  fy('M9: 全角・混在数字キーを除外', { '１０': 89, '１１': 6, '20１2': 18, 'Go': 12 }, ['Go'])
  fy('M10: バージョン断片キー(9i/11g)を除外', { '9i': 10, '11g': 10, '２２c': 5, 'Rails7': 24 }, ['Rails7'])
  fy('M11: 連続スペース複合キーを分割', { 'Perl    Ksh': 33, 'Java   JavaScript': 33 }, ['Java', 'JavaScript', 'Ksh', 'Perl'])
  fy('M12: セクションラベル：値キーはスキル名部分だけ残す', { 'フレームワーク : Flask': 13, 'フレームワーク ： Pandas': 6, '言語 ： Spring': 20 }, ['Flask', 'Pandas', 'Spring'])
}

console.log('=== N. extractSkillYearsFromBodyText: 本文の年数パターン（IM実メール #123） ===')
{
  const bt = (label, text, expect) => {
    const got = extractSkillYearsFromBodyText(text)
    const gotSkills = Object.fromEntries(Object.entries(got).filter(([k]) => !k.startsWith('_')))
    const ok = Object.keys(gotSkills).length === Object.keys(expect).length
      && Object.entries(expect).every(([k, v]) => gotSkills[k] === v)
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`, JSON.stringify(gotSkills)) }
    else { fail++; failures.push(label); console.log(`  FAIL ${label}\n       expect=${JSON.stringify(expect)} got=${JSON.stringify(gotSkills)}`) }
  }
  // 実害(#123): アリュートIMメール「・JAVA10年以上 (spring、seaser2、SAstrutsなど)」が
  // スキル名と数字の間にスペースがなく patternBullet で拾えなかった
  bt('N1: 箇条書き・名前と年数が密着（・JAVA10年以上）',
    '■スキル概要：\n・エンジニア歴12年\n・JAVA10年以上 (spring、seaser2、SAstrutsなど)\n・工程に関しては基本設計から対応可能',
    { JAVA: 120 })
  // 実害(#123): 「メイン言語のJavaは10年近くの実績がございます」の自然文
  bt('N2: 自然文「Javaは10年近くの実績」',
    'メイン言語のJavaは10年近くの実績がございます。',
    { Java: 120 })
  bt('N3: 自然文「Pythonも3年以上の経験」',
    '直近ではPythonも3年以上の経験があります。',
    { Python: 36 })
  // 誤爆防止: 単なる「Windows10」等の製品名+数字は年ラベルなしなら拾わない
  bt('N4: 製品名+数字のみは拾わない',
    '・Windows10、CentOS7 の環境構築\n・Oracle19c の運用',
    {})
  // 既存パターンの回帰: スペースありの箇条書きは従来どおり
  bt('N5: 既存の箇条書き（スペースあり）回帰',
    '● Java　5年\n・Python　3年',
    { Java: 60, Python: 36 })
}

console.log('=== O. 期間ヘッダー繰り返し型（K_M実ファイル: 「4年」「YYYY/MM」テキスト日付） ===')
{
  const { extractSkillYearsPeriodHeader } = await import('./_extractors.gen.mjs')
  // K_M.xlsx ブロック1の再現: 期間ヘッダー繰り返し・「2020/04」-「2024/03」テキスト日付・
  // 明示期間「4年」（月なし）・【言語】【環境】縦積みセル
  const mk = (row, col, value) => ({ row, col, rowEnd: row, colEnd: col, value })
  const cells = [
    mk(0, 2, '期間'),
    mk(1, 0, '1'), mk(1, 2, '2020/04'), mk(1, 6, '-'), mk(1, 7, '2024/03'),
    mk(2, 2, '4年'),
    mk(4, 2, '【言語】\n　C言語\n　PHP\n\n【OS】\n　Windows11\n\n【環境】\n　MySQL\n　Excel'),
    mk(6, 2, '期間'),
    mk(7, 0, '2'), mk(7, 2, '2024/04'), mk(7, 6, '-'), mk(7, 7, '2024/06'),
    mk(8, 2, '0年3ヶ月'),
    mk(10, 2, '【言語】\n　JavaScript\n\n【OS】\n　Windows11'),
  ].sort((a, b) => a.row - b.row || a.col - b.col)
  const got = extractSkillYearsPeriodHeader(cells)
  const skills = Object.fromEntries(Object.entries(got).filter(([k]) => !k.startsWith('_')))
  const expect = { 'C言語': 48, 'PHP': 48, 'Windows11': 51, 'MySQL': 48, 'Excel': 48, 'JavaScript': 3 }
  const ok = Object.keys(skills).length === Object.keys(expect).length
    && Object.entries(expect).every(([k, v]) => skills[k] === v)
  if (ok) { pass++; if (verbose) console.log('  PASS O1', JSON.stringify(skills)) }
  else {
    fail++; failures.push('O1: K_M型 4年+YYYY/MM日付+【環境】')
    console.log(`  FAIL O1: K_M型 4年+YYYY/MM日付+【環境】\n       expect=${JSON.stringify(expect)}\n       got   =${JSON.stringify(skills)}`)
  }

  // T.S型実ファイル: 期間ヘッダーが「期　間」（全角スペース入り）で /^期間$/ に不一致だった
  const cells2 = [
    mk(0, 1, '期　間'),
    mk(1, 0, '2023/5/31'), mk(1, 5, '【言語】\n　・HTML\n\n【環境】\n  ・Unity'),
    mk(2, 0, '~'),
    mk(3, 0, '2025/3/30'),
    mk(4, 0, '1年10ヶ月'),
    mk(6, 1, '期　間'),
    mk(7, 0, '2020/2/16'), mk(7, 5, '【言語】\n　・SQL'),
    mk(8, 0, '~'),
    mk(9, 0, '2023/1/30'),
    mk(10, 0, '3年'),
  ].sort((a, b) => a.row - b.row || a.col - b.col)
  const got2 = extractSkillYearsPeriodHeader(cells2)
  const skills2 = Object.fromEntries(Object.entries(got2).filter(([k]) => !k.startsWith('_')))
  const expect2 = { 'HTML': 22, 'Unity': 22, 'SQL': 36 }
  const ok2 = Object.keys(skills2).length === Object.keys(expect2).length
    && Object.entries(expect2).every(([k, v]) => skills2[k] === v)
  if (ok2) { pass++; if (verbose) console.log('  PASS O2', JSON.stringify(skills2)) }
  else {
    fail++; failures.push('O2: T.S型 全角スペース入り期間ヘッダー')
    console.log(`  FAIL O2: T.S型 全角スペース入り期間ヘッダー\n       expect=${JSON.stringify(expect2)}\n       got   =${JSON.stringify(skills2)}`)
  }
}

console.log('=== Q. scoreProseRoles: 役割の主・副ランキング ===')
{
  const { scoreProseRoles } = await import('./_extractors.gen.mjs')
  const q = (label, prose, fullText, expectOrder) => {
    const { roles, roleScores } = scoreProseRoles(prose, fullText ?? prose)
    const ok = JSON.stringify(roles) === JSON.stringify(expectOrder)
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`, JSON.stringify(roleScores)) }
    else {
      fail++; failures.push(label)
      console.log(`  FAIL ${label}\n       expect=${JSON.stringify(expectOrder)}\n       got   =${JSON.stringify(roles)} scores=${JSON.stringify(roleScores)}`)
    }
  }
  // 「として」明示 > 単発言及
  q('Q1: 「PMOとして6年」が主・PL言及は副',
    'PMOとして約6年、大規模プロジェクトに携わってきました。直近はプロジェクトリーダーの補佐も経験。',
    undefined,
    ['PMO', 'プロジェクトリーダー'])
  // 営業の"盛り"（対応可）は主の根拠にしない
  q('Q2: 「PMOとしても対応可能」は主にならずSEが主',
    'システムエンジニアとして10年の経験があります。PMOとしても対応可能です。',
    undefined,
    ['システムエンジニア', 'PMO'])
  // 冒頭（件名・売り文句）シグナル
  q('Q3: 件名の【PMO要員】が主・本文後半のSEは副',
    'ここは20文字を超える文章行として扱われるための前置きの文になります、PMO案件を希望。テスト環境の構築でシステムエンジニア業務も少々。',
    '【PMO要員】のご紹介\n' + '営業本文の説明が続きます。'.repeat(10) + '\nPMO案件を希望。テスト環境の構築でシステムエンジニア業務も少々。',
    ['PMO', 'システムエンジニア'])
  // ヘルプデスク（2026-08-14 追加。open案件の半分がヘルプデスク系なのにラベルが無かった）
  q('Q3b: 「ヘルプデスクとして」が主・運用保守は副',
    'ヘルプデスクとして5年、社内ユーザーからの問い合わせ対応を担当。運用保守の経験もあります。',
    undefined,
    ['ヘルプデスク', '運用保守'])
  q('Q3c: サービスデスク・ユーザーサポートも同じラベルに寄せる',
    'サービスデスクでの一次受けを担当し、ユーザーサポートの窓口も兼務していました。',
    undefined,
    ['ヘルプデスク'])
  // 経歴表の「ポジション」次行シグナル（TMK型の縦積み）
  q('Q4: ポジション行の次行の役割が優位',
    '運用保守の現場経験が長く、チームでの調整業務を担当してきました。テスト設計の経験もあります。',
    '運用保守の現場経験が長く、チームでの調整業務を担当してきました。テスト設計の経験もあります。\nポジション\n運用保守',
    ['運用保守', 'テストエンジニア'])
}

console.log('=== R. assignAttachmentsToBlocks（ブロック×添付の割当・管理番号マッチ） ===')
{
  const { assignAttachmentsToBlocks } = await import('./_extractors.gen.mjs')
  const r = (label, blocks, attachments, expect) => {
    const got = assignAttachmentsToBlocks(blocks, attachments)
    const gotObj = Object.fromEntries([...got.entries()].map(([k, v]) => [k, v.label]))
    const ok = JSON.stringify(gotObj) === JSON.stringify(expect)
    if (ok) { pass++; if (verbose) console.log(`  PASS ${label}`) }
    else {
      fail++; failures.push(label)
      console.log(`  FAIL ${label}\n       expect=${JSON.stringify(expect)}\n       got   =${JSON.stringify(gotObj)}`)
    }
  }
  // 実害(2026-08-12 キャル): 添付名が管理番号のみで名前・駅のどちらでも当たらず
  // D-UNASSIGNED（3日で7件）。本文ブロックの「①■24272」と番号で照合する
  r('R1: 管理番号でブロックと添付を照合（キャル型）',
    [
      { name: 'CS', station: '新井薬師駅', text: '①■24272　若手WEBオープン/インフラエンジニア CS 新井薬師駅 単価60万' },
      { name: 'KH', station: '飯山満駅', text: '②■31265　ABAPエンジニア KH 飯山満駅 単価65万' },
    ],
    [{ label: 'Excelファイル(24272職務経歴書.xls)' }, { label: 'Excelファイル(31265職務経歴書.xlsx)' }],
    { 0: 'Excelファイル(24272職務経歴書.xls)', 1: 'Excelファイル(31265職務経歴書.xlsx)' })
  // 両ブロックに共通する番号（件名由来の西暦等）は一意でないため割当に使わない
  r('R2: 全ブロック共通の番号は照合に使わない',
    [
      { name: 'AB', station: null, text: '2026年8月開始 単価60万' },
      { name: 'CD', station: null, text: '2026年8月開始 単価65万' },
    ],
    [{ label: 'Excelファイル(2026経歴書.xlsx)' }],
    {})
  // 日付8桁（20260628）からは4〜6桁トークンを拾わない（誤マッチ防止）。
  // ブロックを2つにしてパス3（残余1対1マッチ）が発動しない条件で番号ロジックだけを見る
  r('R3: ファイル名の日付8桁は番号として扱わない',
    [
      { name: 'EF', station: null, text: '管理番号 2606 の人材' },
      { name: 'GH', station: null, text: '番号なしの人材' },
    ],
    [{ label: 'Excelファイル(Skill_XY_20260628.xlsx)' }],
    {})
  // 従来パスの回帰防止: ファイル名の名前マッチが最優先
  r('R4: 名前マッチは番号より優先（従来パス1）',
    [{ name: 'K.N', station: '亀有駅', text: '■12345 K.N 亀有駅 単価60万' }],
    [{ label: 'Excelファイル(K.N_亀有.xlsm)' }, { label: 'Excelファイル(12345一覧.xlsx)' }],
    { 0: 'Excelファイル(K.N_亀有.xlsm)' })
  // text 未指定でも従来どおり動く（後方互換）
  r('R5: text なしブロックは従来パスのみで割当',
    [{ name: 'GH', station: '横浜駅' }],
    [{ label: 'Excelファイル(GH_横浜.xlsx)' }],
    { 0: 'Excelファイル(GH_横浜.xlsx)' })
}

console.log('=== S. cellToText: 日付書式が付いた数値セル（T.A型） ===')
{
  // 本番は XLSX.read(..., { cellDates: true }) で読む（index.ts:7299）。
  // 「期間」列に日数（253日など）を入れて "00年9ヶ月" と表示する書式を当てているファイルがあり、
  // その数値が Date に化けて 1900〜1902年の日付になる。cellToText がそれを "1900/9/9" と
  // 出力すると期間列が壊れ、スキル表の抽出が丸ごと失敗する。
  // 実例: T.A（2b2234fb）のスキルシートは 52スキル取れるはずが grid=0 / cells=0 で全滅していた。
  // セルの表示文字列（w）は "00年9ヶ月" と正しいので、実在しない年ならそちらを使う。
  const ct = (label, cell, expect) => {
    const got = cellToText(cell)
    if (got === expect) { pass++; if (verbose) console.log(`  PASS ${label} -> "${got}"`) }
    else {
      fail++
      failures.push(label)
      console.log(`  FAIL ${label}`)
      console.log(`       expect: "${expect}"`)
      console.log(`       got   : "${got}"`)
    }
  }
  const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day))

  ct('S1: 期間セル（253日→"00年9ヶ月"）は表示文字列を使う',
    { v: d(1900, 9, 9), w: '00年9ヶ月' }, '00年9ヶ月')
  ct('S2: 期間セル（589日→"01年8ヶ月"）',
    { v: d(1901, 8, 11), w: '01年8ヶ月' }, '01年8ヶ月')
  ct('S3: 実在の日付は YYYY/M/D に正規化する（従来どおり）',
    { v: d(2019, 3, 1), w: '2019/3/1' }, '2019/3/1')
  ct('S4: 生年月日1969年も日付として扱う（1910年以降）',
    { v: d(1969, 11, 8), w: '1969年11月8日' }, '1969/11/8')
  ct('S5: 1910年ちょうどは日付',
    { v: d(1910, 1, 1), w: '1910/1/1' }, '1910/1/1')
  ct('S6: 1909年は日付扱いしない（表示文字列を使う）',
    { v: d(1909, 12, 31), w: '01年11ヶ月' }, '01年11ヶ月')
  ct('S7: 表示文字列が無ければ従来どおり日付として出す（後方互換）',
    { v: d(1900, 9, 9) }, '1900/9/9')
  ct('S8: 2100年超は従来どおり表示文字列',
    { v: d(2200, 1, 1), w: '2200/1/1' }, '2200/1/1')
}

console.log(`\n📊 ${pass} passed / ${fail} failed（全${pass + fail}ケース）`)
if (fail > 0) console.log('FAILED:', failures.join(' | '))
process.exit(fail > 0 ? 1 : 0)
