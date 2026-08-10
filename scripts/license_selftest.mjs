#!/usr/bin/env node
// license_selftest.mjs — 派遣・職業紹介の許可番号抽出の単体テスト
//
// 取りこぼすと agent_companies に番号が入らず、verify-agent-license による
// 厚労省サイトでの照合が回らない（＝無許可business者を検知できない）。
// 署名欄は表記のばらつきが大きいので、実際に見かける形を網羅する。
//
// 実行: node scripts/license_selftest.mjs
import { extractLicenseNumbers } from './_extractors.gen.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (JSON.stringify(got) === JSON.stringify(expect)) pass++
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)}\n    exp=${JSON.stringify(expect)}`) }
}
const haken = (s) => extractLicenseNumbers(s).haken
const shokai = (s) => extractLicenseNumbers(s).shokai

// ── 派遣許可番号（現行表記）──
t('派＋半角', haken('派13-317179'), '派13-317179')
t('派＋空白', haken('派 13-317179'), '派13-317179')
t('ラベル付き', haken('労働者派遣事業許可番号：派13-317179'), '派13-317179')
t('括弧付き', haken('(派)13-317179'), '派13-317179')

// ── 2015年법改正前の旧表記。古い署名に残っており、従来は丸ごと取りこぼしていた ──
t('般（一般労働者派遣）', haken('般13-317179'), '般13-317179')
t('特（特定労働者派遣）', haken('特13-317179'), '特13-317179')
t('般＋ラベル', haken('派遣事業許可番号 般13-303936'), '般13-303936')

// ── 全角。署名欄は全角で書かれることが多い ──
t('全角数字', haken('派１３-３１７１７９'), '派13-317179')
t('全角ハイフン', haken('派13ー317179'), '派13-317179')
t('全角スペース', haken('派　13-317179'), '派13-317179')

// ── 職業紹介許可番号 ──
t('ユ・ハイフンなし', shokai('13-ユ123456'), '13-ユ123456')
t('ユ・ハイフンあり', shokai('13-ユ-123456'), '13-ユ123456')
t('ユ・全角ハイフン', shokai('13ーユー123456'), '13-ユ123456')
t('ユ・全角数字', shokai('１３-ユ１２３４５６'), '13-ユ123456')

// ── 誤検出しないこと ──
t('番号が無ければ null', haken('株式会社シンクワン 営業部'), null)
t('電話番号を拾わない', haken('TEL 03-1234-5678'), null)
t('紹介番号が無ければ null', shokai('派13-317179'), null)

// ── 実際の署名ブロックから拾えること ──
const sig = [
  '*************************',
  '株式会社サンプル',
  '営業部　山田 太郎',
  '労働者派遣事業許可番号：般13-303936',
  '有料職業紹介事業許可番号：13-ユ-303936',
  'TEL 03-0000-0000',
  '*************************',
].join('\n')
t('署名から派遣番号', haken(sig), '般13-303936')
t('署名から紹介番号', shokai(sig), '13-ユ303936')

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
