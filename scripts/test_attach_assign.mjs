#!/usr/bin/env node
// 名簿メールの「ブロック × 添付」割当の回帰テスト。
// 本物の assignAttachmentsToBlocks（_extractors.gen.mjs）を使う。手写しのレプリカにしない。
//
// 使い方: node scripts/test_attach_assign.mjs
import { assignAttachmentsToBlocks } from './_extractors.gen.mjs'

let pass = 0, fail = 0
const check = (title, blocks, attachments, expected) => {
  const r = assignAttachmentsToBlocks(blocks, attachments)
  const got = blocks.map((_, i) => r.get(i)?.label ?? null)
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✅ ${title}`) }
  else {
    fail++
    console.log(`  ❌ ${title}`)
    console.log(`     期待: ${JSON.stringify(expected)}`)
    console.log(`     実際: ${JSON.stringify(got)}`)
  }
}

const att = (n) => ({ label: `Excelファイル(${n}職務経歴書.xlsx)`, content: '' })

console.log('=== 管理番号による割当（キャル型）===')
// 実メール（2026-08-29 prod）: 冒頭に番号一覧があり、そのあと各人の詳細が続く。
// 一覧が1人目のブロックに含まれると、他人の番号まで1人目に出て「1箇所だけ」条件が崩れ、
// 2人目以降が全滅していた（12人ぶん）。
{
  const preamble = [
    '本日は下記の要員をご紹介いたします。',
    '①■5756　SAP(ABAP/FI/MDG),基本設計～運用保守',
    '②■24130　保険系インフラ運用保守,RHEL/Linux',
    '③■31873　ExcelVBA/AccessVBA,業務効率化ツール',
  ].join('\n')
  const blocks = [
    { name: 'KM', station: '', text: `${preamble}\n①■5756　SAP(ABAP/FI/MDG) 45歳 男性 単価70万 リモート可 経験15年` },
    { name: 'TM', station: '', text: '②■24130　保険系インフラ運用保守 38歳 男性 単価65万 常駐可 経験10年' },
    { name: 'YS', station: '', text: '③■31873　ExcelVBA/AccessVBA 29歳 女性 単価50万 経験5年' },
  ]
  check('冒頭に番号一覧があっても全員に割り当たる', blocks, [att(5756), att(24130), att(31873)],
    ['Excelファイル(5756職務経歴書.xlsx)', 'Excelファイル(24130職務経歴書.xlsx)', 'Excelファイル(31873職務経歴書.xlsx)'])
}
{
  const blocks = [
    { name: 'KM', station: '', text: '①■5756　SAP 45歳 男性 単価70万' },
    { name: 'TM', station: '', text: '②■24130　インフラ 38歳 男性 単価65万' },
  ]
  check('一覧が無い場合も従来どおり割り当たる', blocks, [att(5756), att(24130)],
    ['Excelファイル(5756職務経歴書.xlsx)', 'Excelファイル(24130職務経歴書.xlsx)'])
}
{
  // 番号が本人ブロックにしか無く、対応する添付が無い場合は割り当てない
  const blocks = [
    { name: 'KM', station: '', text: '①■5756　SAP 45歳' },
    { name: 'TM', station: '', text: '②■24130　インフラ 38歳' },
  ]
  check('対応する添付が無いブロックは未割当のまま', blocks, [att(5756)],
    ['Excelファイル(5756職務経歴書.xlsx)', null])
}

console.log('\n=== 氏名による割当（従来経路が壊れていないこと）===')
{
  const blocks = [
    { name: 'T.A', station: '新宿', text: 'T.A 35歳' },
    { name: 'S.K', station: '渋谷', text: 'S.K 42歳' },
  ]
  const as = [
    { label: 'Excelファイル(S.K_渋谷.xlsx)', content: '' },
    { label: 'Excelファイル(T.A_新宿.xlsx)', content: '' },
  ]
  check('ファイル名の氏名で割り当たる', blocks, as,
    ['Excelファイル(T.A_新宿.xlsx)', 'Excelファイル(S.K_渋谷.xlsx)'])
}
{
  const blocks = [
    { name: 'T.A', station: '新宿', text: 'T.A 35歳' },
    { name: 'S.K', station: '渋谷', text: 'S.K 42歳' },
  ]
  const as = [{ label: 'Excelファイル(渋谷_スキルシート.xlsx)', content: '' }]
  check('駅名で割り当たる（他人の名前を含まない場合）', blocks, as,
    [null, 'Excelファイル(渋谷_スキルシート.xlsx)'])
}

console.log(`\n合計: ${pass} 通過 / ${fail} 失敗`)
process.exit(fail === 0 ? 0 : 1)
