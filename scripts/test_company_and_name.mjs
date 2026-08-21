#!/usr/bin/env node
// =============================================================================
// 会社名（sanitizeFromCompany）と氏名フォールバック（extractNameFallback）の回帰テスト
// =============================================================================
// 使い方: node scripts/test_company_and_name.mjs
//
// index.ts から自動生成された _extractors.gen.mjs を読むので本番と食い違わない。
// index.ts を直したら sync_extractors.mjs を先に流すこと。
// =============================================================================
import { sanitizeFromCompany, extractNameFallback, stripInitialSuffix } from './_extractors.gen.mjs'

const COMPANY_CASES = [
  // 2026-08-21 実害: 挨拶文「株式会社Flexibilityです。」がそのまま社名になっていた（prod 4件）
  ['株式会社Flexibilityです',            '株式会社Flexibility'],
  ['株式会社Flexibilityです。',          '株式会社Flexibility'],
  ['株式会社アルファでした',             '株式会社アルファ'],
  ['合同会社ベータと申します',           '合同会社ベータ'],
  // 既存の挙動を壊していないこと
  ['株式会社GFDの本田でございます。',    '株式会社GFD'],
  ['株式会社イチアール小島でございます', '株式会社イチアール'],
  ['株式会社JQIT営業部で御座います',     '株式会社JQIT'],
  ['株式会社小川でございます',           null],           // 社名が無く個人の自己紹介
  ['株式会社エクスプラザ様',             '株式会社エクスプラザ'],  // 宛先の敬称を落とす
  ['ＷｅａＬｉｖｅ株式会社',             'ＷｅａＬｉｖｅ株式会社'],
  ['Next IT Consulting株式会社',         'Next IT Consulting株式会社'],
  ['株式会社ヘルスベイシス https://x.co', '株式会社ヘルスベイシス'],
  ['株式会社サイバーエージェント',       '株式会社サイバーエージェント'],
  ['株式会社ボイス',                     null],           // 自社名
]

const NAME_CASES = [
  // 2026-08-21 実害: 「YT☆福岡」が氏名として取れず、本人が登録されなかった
  ['YT☆福岡（弊社個人事業主）\n最寄：吉富駅',  'YT'],
  ['■SY＠牛久\n【年齢】59歳',                  'SY'],
  ['・YM＠鎌ヶ谷',                              'YM'],
  ['HT＠福岡／一社先個人事業主',                'HT'],
  // ラベルがあればそちらが優先
  ['氏名：K.M\n年齢：30',                       'K.M'],
  // 記号なしの大文字2文字は技術語と区別できないので拾わない
  ['言語：VC++、C#、VB／VBA',                   null],
  ['担当工程：PM、PMO、SE',                     null],
]

const SUFFIX_CASES = [
  ['YM＠鎌ヶ谷', 'YM'],
  ['YT☆福岡',   'YT'],
  ['K.H（男性/42歳）', 'K.H（男性/42歳）'],  // 構造化情報は切らない
]

let passed = 0, failed = 0
const check = (label, got, want) => {
  if (got === want) { passed++; return }
  failed++
  console.log(`❌ ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`)
}

console.log('── sanitizeFromCompany ──')
for (const [input, want] of COMPANY_CASES) check(JSON.stringify(input), sanitizeFromCompany(input), want)
console.log('── extractNameFallback ──')
for (const [input, want] of NAME_CASES) check(JSON.stringify(input.split('\n')[0]), extractNameFallback(input), want)
console.log('── stripInitialSuffix ──')
for (const [input, want] of SUFFIX_CASES) check(JSON.stringify(input), stripInitialSuffix(input), want)

console.log(`\n📊 ${passed} passed / ${failed} failed（全${COMPANY_CASES.length + NAME_CASES.length + SUFFIX_CASES.length}ケース）`)
process.exit(failed ? 1 : 0)
