#!/usr/bin/env node
// same_mail_dedup_selftest.mjs — 同一メール内で同名だったブロックの「別人」判定
//
// 一斉配信メールは表示名がイニシャルなので同姓同名が同じメールに並ぶ。
// 名前一致だけで UPDATE すると後勝ちで前の人が消える（2026-08-16 フォスターネット 18名→16件）。
// 一方、本文＋添付のように同一人物が複数ブロックに割れる正常ケースは潰してはいけない。
//
// 使い方: node scripts/same_mail_dedup_selftest.mjs
import { sameMailConflicts } from './_extractors.gen.mjs'

const cases = [
  // ── 別人（1項目でも食い違えば別人。2026-08-16 ユーザー判断） ──
  ['実例 K.H: 駅も単価も違う',
    { station: '初台駅', prefecture: '東京都', age: 42, rate: '87万円' },
    { station: '松戸駅', prefecture: '千葉県', age: 48, rate: '82万円' }, true],
  ['実例 S.Y: 片方が駅なし・県のみ',
    { station: '勝どき駅', prefecture: '東京都', age: 45, rate: '110万円' },
    { station: null, prefecture: '宮城県', age: 52, rate: '75万円' }, true],
  ['駅だけ違う（年齢・単価は未取得）',
    { station: '初台駅', prefecture: null, age: null, rate: null },
    { station: '松戸駅', prefecture: null, age: null, rate: null }, true],
  ['単価だけ違う',
    { station: null, prefecture: null, age: null, rate: '87万円' },
    { station: null, prefecture: null, age: null, rate: '82万円' }, true],
  ['年齢だけ違う',
    { station: '新宿駅', prefecture: '東京都', age: 42, rate: '80万円' },
    { station: '新宿駅', prefecture: '東京都', age: 48, rate: '80万円' }, true],

  // ── 同一人物（潰してはいけない。本文＋添付で片方が欠けるのが典型） ──
  ['全項目一致', { station: '新宿駅', prefecture: '東京都', age: 30, rate: '70万円' },
    { station: '新宿駅', prefecture: '東京都', age: 30, rate: '70万円' }, false],
  ['添付側が空（片方 null は別人の根拠にしない）',
    { station: null, prefecture: null, age: null, rate: null },
    { station: '新宿駅', prefecture: '東京都', age: 30, rate: '70万円' }, false],
  ['本文側だけ駅あり・他は一致',
    { station: '新宿駅', prefecture: '東京都', age: 30, rate: null },
    { station: null, prefecture: '東京都', age: 30, rate: '70万円' }, false],
  ['空文字は未取得として扱う',
    { station: '', prefecture: '', age: null, rate: '' },
    { station: '新宿駅', prefecture: '東京都', age: 30, rate: '70万円' }, false],
  ['年齢が数値と文字列（型違いは食い違いにしない）',
    { station: '新宿駅', prefecture: '東京都', age: 30, rate: '70万円' },
    { station: '新宿駅', prefecture: '東京都', age: '30', rate: '70万円' }, false],
]

let ng = 0
for (const [label, a, b, wantDistinct] of cases) {
  const conflicts = sameMailConflicts(a, b)
  const got = conflicts.length > 0
  const ok = got === wantDistinct
  if (!ok) ng++
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label} → ${got ? `別人(${conflicts.join('・')})` : '同一人物'}`)
}
console.log(`\n${cases.length - ng}/${cases.length} 通過`)
process.exit(ng ? 1 : 0)
