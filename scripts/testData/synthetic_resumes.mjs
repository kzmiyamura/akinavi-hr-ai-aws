// synthetic_resumes.mjs — 合成の経歴書ワークブック（PII なし・実ファイル不要）
//
// 実データ（testData/excel）は PII のため git 管理外で、CI にも他マシンにも無い。
// 「AI経路がシートを選び損ねる」型の不具合は形さえ再現できれば十分なので、
// 問題の形だけを合成して常に手元にある回帰にする。
//
// 元ネタは 2026-08-14 に実測した YN の経歴書:
//   ・年と月が別セル（'2023' | '12'）の記入フォーム型 → 日付セル0件と判定され AI に渡らない
//   ・2枚目が「スキルシート(NW・SV記入例)」＝テンプレートのサンプル記入で、
//     日付が大量にある。日付数だけで選ぶと**他人の記入例を本人の経歴として転記する**
import XLSX from 'xlsx'

const sheet = (rows) => XLSX.utils.aoa_to_sheet(rows)

/** 年・月が別セルに分かれた記入フォーム型（本人のシートのみ）。
 *
 *  **実ファイル7件の並びに合わせてある**（2026-08-14・`probe_year_cell_layout.mjs` で実測）。
 *  初版は月を年の右隣に置いていたが、実物はセル結合で空セルと「年」ラベルが挟まり、
 *  月は右5・右6 に来るのが主流だった。想定で作ったせいで取り逃しをテストが素通りさせた:
 *
 *    2026 |    |    | 年 |    | 9 |    | 月     ← 右5（最多）
 *    2019 | 年 | …  | 9                        ← 右2
 */
export function formStyleWorkbook() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet([
    ['スキルシート'],
    ['', '氏名', '', '', 'テスト 太郎', '', '', '', '(満)', '', '30', '', '歳'],
    [],
    ['', '1', '', '2023', '', '', '年', '', '12', '', '月', '', 'ECサイト開発'],
    ['', '', '', '2024', '', '', '年', '', '11', '', '月', '', 'PHP, Laravel, MySQL'],
    ['', '2', '', '2024', '', '', '年', '', '12', '', '月', '', '機材管理システム'],
    ['', '', '', '2025', '', '', '年', '', '8', '', '月', '', 'PHP, Laravel, Docker'],
    ['', '3', '', '2025', '', '', '年', '', '9', '', '月', '', '社内基幹の改修'],
    ['', '', '', '2026', '', '', '年', '', '4', '', '月', '', 'JavaScript, MySQL'],
    // 右隣に月が来る形（実ファイル HT / KY の右2型）
    ['', '4', '', '2019', '年', '10', '月', '', '', '', '', '', '保守運用'],
  ]), 'スキルシート')
  return wb
}

/** 年セルの右に無関係な数字が来るだけのシート（資格欄など）。
 *  窓を右6まで広げた副作用で「1999年 … 認定1件」を日付と誤認しないことの確認。
 *  日付とみなす組が無いので null が正解 */
export function yearWithoutMonthWorkbook() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet([
    ['資格・スキル'],
    ['', '資格', '', '', 'システムアドミニストレーター認定', '', '', '1999', '', '', '', '', '', '', '3'],
    ['', '保有言語', '', 'Java', '', '', '', '', '', '', '', '', '', '', '5'],
  ]), '資格')
  return wb
}

/** 本人シート（記入フォーム型・少量）＋ 記入例シート（フル日付・大量）。
 *  日付の多さだけで選ぶと記入例が勝つ。実ファイル YN と同じ構成 */
export function withExampleSheetWorkbook() {
  const wb = formStyleWorkbook()
  const rows = [
    ['スキルシート（記入例）'],
    ['氏名', '山田 花子（記入例）', '', '生年月日', '1993/05/01'],
    [],
    ['No', '期間', '業務内容', '使用技術'],
  ]
  // 記入例は本人シートより多くの「西暦で始まるセル」を持つ
  for (let i = 0; i < 12; i++) {
    const y = 2013 + i
    rows.push([String(i + 1), `${y}/04/01～${y + 1}/03/31`, `ネットワーク構築 第${i + 1}期`,
      'Cisco, VMware, Windows Server'])
  }
  XLSX.utils.book_append_sheet(wb, sheet(rows), 'スキルシート(NW・SV記入例)')
  return wb
}

/** **実ファイル YN と同じ構成**: 本人シートは日付が読めない形（年月が縦持ち等）で、
 *  記入例シートだけが日付を持つ。ここで記入例を選ぶと他人の経歴を本人として登録する。
 *  期待値は「読めない（null）」——読めないまま返すのが正しい（2026-08-14 実害あり） */
export function unreadableOwnSheetWorkbook() {
  const wb = XLSX.utils.book_new()
  // 本人シート: 年と月が離れた位置にあり、行内の近傍では組にならない
  XLSX.utils.book_append_sheet(wb, sheet([
    ['スキルシート'],
    ['氏名', 'テスト 次郎'],
    ['開始年', '2023'],
    ['開始月', '12'],
    ['業務内容', 'ECサイト開発'],
    ['使用技術', 'PHP, Laravel'],
  ]), 'スキルシート')
  const rows = [['スキルシート（記入例）'], ['No', '期間', '業務内容', '使用技術']]
  for (let i = 0; i < 12; i++) {
    const y = 2013 + i
    rows.push([String(i + 1), `${y}/04/01～${y + 1}/03/31`, `ネットワーク構築 第${i + 1}期`,
      'Zabbix, Ansible, Terraform'])
  }
  XLSX.utils.book_append_sheet(wb, sheet(rows), 'スキルシート(NW・SV記入例)')
  return wb
}

/** 従来どおり素直に日付が入っているシート（変更で壊していないことの確認用） */
export function plainDateWorkbook() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet([
    ['職務経歴書'],
    ['期間', '業務内容', '使用技術'],
    ['2020/04～2022/03', '基幹システム保守', 'Java, Oracle Database'],
    ['2022/04～2024/09', 'Web API 開発', 'Java, Spring Boot, PostgreSQL'],
  ]), '職務経歴')
  return wb
}

/** 直接実行するとファイルとして書き出す（demo への投入用）。
 *  例: node scripts/testData/synthetic_resumes.mjs form C:\tmp\form_style.xlsx */
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const kind = process.argv[2] ?? 'form'
  const out = process.argv[3] ?? `${kind}.xlsx`
  const wb = kind === 'example' ? withExampleSheetWorkbook()
    : kind === 'plain' ? plainDateWorkbook() : formStyleWorkbook()
  XLSX.writeFile(wb, out)
  console.log(`書き出しました: ${out}`)
}

export const CASES = [
  { name: '記入フォーム型（年月が別セル）', wb: formStyleWorkbook, expectSheet: 'スキルシート' },
  { name: '記入例シート付き', wb: withExampleSheetWorkbook, expectSheet: 'スキルシート' },
  // ★実害ケース: 記入例で代替してはいけない。null が正解（他人の経歴を書かない）
  { name: '本人シートが読めない＋記入例あり', wb: unreadableOwnSheetWorkbook, expectSheet: null },
  // 窓を右6まで広げた副作用よけ。年はあるが月が無い（資格欄）→ 日付とみなさない
  { name: '年セルだけで月が無い（資格欄）', wb: yearWithoutMonthWorkbook, expectSheet: null },
  { name: '通常の日付表記', wb: plainDateWorkbook, expectSheet: '職務経歴' },
]
