#!/usr/bin/env node
/**
 * 雇用形態・商流の抽出テスト（2026-10-20）。
 *
 * きっかけ: 営業の通知ルール「大阪・自社・正社員/契約/派遣」に、スキルも地域も
 * 合っているのに通知されない人が3人いた。本番を調べたら1人（AK-004505）は本文に
 * 「[所 属] BP正社員」と**書いてある**のに employmentType / commercialFlow が
 * 空だった。ラベルの判定が全角括弧【 所 属 】とコロン区切り「所属：」しか見ておらず、
 * **半角括弧でコロンの無い形**（SES業界の名簿メールに多い）を読めていなかった。
 * ローカル控え実測で 134人（雇用形態が未取得の1,858人の7.2%）がこの形だけで書かれている。
 *
 * 判定は index.ts が正。ここは _extractors.gen.mjs（index.ts から生成）を読むので、
 * index.ts を直したら `node scripts/sync_extractors.mjs` を先に回すこと。
 *
 * 使い方: node scripts/test_employment_extraction.mjs
 */
import { extractEmploymentType, parseEmploymentValue } from './_extractors.gen.mjs'

/** [本文, 期待する商流, 期待する雇用形態, 説明] */
const CASES = [
  // ── これまで読めていた形（壊さないための回帰） ──────────────────────────
  ['【氏 名】YA 58歳 男性\n【所 属】弊社個人事業主\n【最寄駅】深江橋駅（大阪）',
    '自社', 'フリーランス', '全角括弧ラベル・弊社個人事業主'],
  ['【名前】S.T（男性・31歳）\n【所属】1社先社員\n【場所】上新庄（大阪）',
    '1社先', '正社員', '全角括弧ラベル・1社先社員'],
  ['■最寄：大阪府 長堀橋駅\n■所属：自社個人事業主\n■期間：即日',
    '自社', 'フリーランス', 'コロン区切り・自社個人事業主'],
  ['・最寄駅：上新庄駅（大阪）\n・所属：弊社フリーランス',
    '自社', 'フリーランス', 'コロン区切り・弊社フリーランス'],
  ['【所 属】一社先個人事業主', '1社先', 'フリーランス', '漢数字の商流'],
  ['雇用形態：契約社員', '自社', '契約社員', 'コロン区切り・契約社員'],
  ['弊社正社員のご紹介です', '自社', '正社員', 'ラベル無し・弊社正社員'],
  ['所属：NAP\nアピールポイント：Java', null, null,
    '所属に会社名しか書いていない人は何も決めない（勝手に自社にしない）'],

  // ── 2026-10-20 に足した形 ───────────────────────────────────────────
  ['[氏 名] MT (24歳/男性)\n[最 寄] 森ノ宮(大阪府)\n[所 属] BP正社員\n[単 価] 50万',
    '1社先', '正社員', '半角括弧ラベル・BP正社員（AK-004505 の実物）'],
  ['[所 属] BP社員', '1社先', '正社員', '半角括弧ラベル・BP社員（控えで35人）'],
  ['［所属］BP正社員', '1社先', '正社員', '全角の角括弧'],
  ['[雇用形態] 派遣社員', '自社', '派遣社員', '半角括弧ラベル・雇用形態'],
  ['[所 属] BPプロパー', '1社先', '正社員', 'プロパー＝その会社の正社員'],
  ['[所 属] BP要員', '1社先', null, '要員は雇用形態ではない（商流だけ決める）'],
  ['所属：協力会社の正社員', '1社先', '正社員', '協力会社は自社ではない'],
  // 一度「グループ会社＝1社先」にしたが戻した（2026-10-20）。控えで157人が自社→1社先に
  // 変わり、本文には「※ご契約の際直接契約可」と書いてある。商流は「直接契約できるか」の
  // 判断材料なので、直接契約できる人を1社先に落とすと営業の読みを狂わせる
  ['【所 属】弊社グループ会社正社員 ※ご契約の際直接契約可', '自社', '正社員',
    'グループ会社は自社のまま（直接契約できる）'],
  // 商流の指定が明示されていれば、BP の有無より明示を採る
  ['[所 属] 2社先BP正社員', '2社先', '正社員', 'N社先の明示が優先'],
]

/** 値だけの判定（parseEmploymentValue）。商流の語を含まない値は自社に寄せる既定を固定する */
const VALUE_CASES = [
  ['BP正社員', '1社先', '正社員'],
  ['弊社正社員', '自社', '正社員'],
  ['正社員', '自社', '正社員'],
  ['NAP', null, null],
]

let fail = 0
console.log('■ 本文からの抽出')
for (const [body, wantFlow, wantType, note] of CASES) {
  const got = extractEmploymentType(body, '')
  const ok = got.commercialFlow === wantFlow && got.employmentType === wantType
  if (!ok) fail++
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${note}`)
  if (!ok) {
    console.log(`        期待: 商流=${wantFlow} 雇用=${wantType}`)
    console.log(`        実際: 商流=${got.commercialFlow} 雇用=${got.employmentType}`)
  }
}

console.log('\n■ 値だけの判定')
for (const [val, wantFlow, wantType] of VALUE_CASES) {
  const got = parseEmploymentValue(val)
  const ok = got.commercialFlow === wantFlow && got.employmentType === wantType
  if (!ok) fail++
  console.log(`${ok ? '  OK  ' : '  FAIL'} 「${val}」→ 商流=${got.commercialFlow} 雇用=${got.employmentType}`)
}

console.log(`\n${fail === 0 ? '✅ 全て通過' : `❌ ${fail}件 失敗`}（${CASES.length + VALUE_CASES.length}件）`)
process.exit(fail === 0 ? 0 : 1)
