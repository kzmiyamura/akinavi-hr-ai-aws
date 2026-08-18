// 氏名・会社名の抽出テスト（2026-08-18）
//
// 実害1: 「【氏　名】：H,I（28歳/男性/日本）」が氏名未取得になった
//   - カンマ補完パターンが「【氏　名】」の閉じ括弧を許していなかった
//   - extractNameFallback は【氏名】固定文字列のみで【氏　名】に非対応、
//     さらにキャプチャが , を終端扱いするため「H」だけになり2文字未満で捨てられた
// 実害2: 「株式会社ai・more(株式会社CyTechから社名変更になります。)」の会社名が
//   「株式会社CyTechから社名変更になります」になった
//   - 署名からは「最後のマッチ」を採る仕様のため、括弧内の注記を拾っていた
//
// 判定は _extractors.gen.mjs 経由で index.ts の実物を読む（レプリカを持たない）。
//   node scripts/test_name_company_extraction.mjs
import { extractNameFallback, isInsideParens } from './_extractors.gen.mjs'

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const eq = (label, got, exp) => check(`${label} → ${JSON.stringify(exp)}`, got === exp, `実際=${JSON.stringify(got)}`)

// ── 氏名: カンマ区切りイニシャル ──────────────────────────
eq('【氏　名】：H,I（28歳/男性/日本）', extractNameFallback('【氏　名】：H,I（28歳/男性/日本）'), 'H.I')
eq('【氏名】：M,T（23）', extractNameFallback('【氏名】：M,T（23）'), 'M.T')
eq('氏名：M，T（全角カンマ）', extractNameFallback('氏名：M，T'), 'M.T')
eq('【名　前】：A,B', extractNameFallback('【名　前】：A,B'), 'A.B')

// ── 氏名: 既存形式を壊していない ────────────────────────
eq('氏名：K.M', extractNameFallback('氏名：K.M'), 'K.M')
eq('【名前】K.M', extractNameFallback('【名前】K.M'), 'K.M')
eq('氏名：田中太郎', extractNameFallback('氏名：田中太郎'), '田中太郎')
eq('T・Y 形式のイニシャル', extractNameFallback('担当は T・Y です'), 'T・Y')

// ── 氏名: カンマ区切りの誤検知が無いこと ────────────────
eq('言語：C,C++ を名前にしない', extractNameFallback('言語：C,C++ / Java'), null)
eq('スキル：A,B を名前にしない', extractNameFallback('スキル：A,B などの経験'), null)
eq('アメリカC.A. を名前にしない', extractNameFallback('アメリカC.A. に駐在'), null)

// ── 会社名: 括弧内注記のガード ──────────────────────────
{
  const sig = '株式会社ai・more(株式会社CyTechから社名変更になります。)'
  const first = sig.indexOf('株式会社')            // 本来の社名
  const second = sig.indexOf('株式会社', first + 1) // 括弧内の旧社名
  check('社名本体は括弧の外と判定される', isInsideParens(sig, first) === false)
  check('括弧内の旧社名は括弧の内と判定される', isInsideParens(sig, second) === true,
    `位置=${second}`)
}
{
  // 法人格の略記「（株）」は括弧が直ちに閉じるので誤検知しない
  const sig = '（株）ai・more 営業部'
  check('（株）表記を括弧内と誤判定しない', isInsideParens(sig, sig.indexOf('ai')) === false)
}
{
  // 行をまたいだら判定をリセットする（署名は複数行）
  const sig = '前の行に開き括弧（があります\n株式会社ai・more'
  check('前行の未閉じ括弧は次行に波及しない', isInsideParens(sig, sig.indexOf('株式会社')) === false)
}

const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length) { console.log('失敗:', failed.map(f => f.name).join(', ')); process.exit(1) }
