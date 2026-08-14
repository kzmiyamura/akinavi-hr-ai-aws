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

/** 年・月が別セルに分かれた記入フォーム型（本人のシートのみ） */
export function formStyleWorkbook() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet([
    ['スキルシート'],
    ['氏名', 'テスト 太郎', '', '年齢', '30'],
    [],
    ['No', '開始年', '開始月', '終了年', '終了月', '業務内容', '使用技術'],
    ['1', '2023', '12', '2024', '11', 'ECサイト開発', 'PHP, Laravel, MySQL'],
    ['2', '2024', '12', '2025', '8', '機材管理システム', 'PHP, Laravel, Docker'],
    ['3', '2025', '9', '2026', '4', '社内基幹の改修', 'JavaScript, MySQL'],
  ]), 'スキルシート')
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
  { name: '通常の日付表記', wb: plainDateWorkbook, expectSheet: '職務経歴' },
]
