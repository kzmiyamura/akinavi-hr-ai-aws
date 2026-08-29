/**
 * 会社名の検閲（inbound-email の isPlausibleCompanyName）の回帰テスト。
 *
 * 会社名の抽出経路は5つあり、それぞれが営業文の断片を拾っていた。
 * 2026-08-29 の実測（直近7日）で 72人ぶんが誤った社名で登録されていた。
 *
 * このテストは手写しのレプリカを作らず、**本番に出す index.ts から関数を切り出して**
 * 検証する。レプリカだとソースと乖離して「テストは通るが本番は直っていない」が起きる。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadGate(): (name: string) => boolean {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name: string) => {
    const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/)\\r?\\n`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return m[1]
  }
  const body = src.match(/function isPlausibleCompanyName\(name: string\): boolean \{([\s\S]*?)\n\}/)
  if (!body) throw new Error('isPlausibleCompanyName を index.ts から取り出せませんでした')
  const code = `
    const COMPANY_NG_SENTENCE = ${pick('COMPANY_NG_SENTENCE')};
    const COMPANY_NG_HEADCOUNT = ${pick('COMPANY_NG_HEADCOUNT')};
    const COMPANY_NG_PERSON = ${pick('COMPANY_NG_PERSON')};
    const COMPANY_NG_DATE = ${pick('COMPANY_NG_DATE')};
    const COMPANY_NG_ROLE_ONLY = ${pick('COMPANY_NG_ROLE_ONLY')};
    const COMPANY_NG_GENERIC = ${pick('COMPANY_NG_GENERIC')};
    const COMPANY_NG_RANDOM = ${pick('COMPANY_NG_RANDOM')};
    const COMPANY_HAS_CORP = ${pick('COMPANY_HAS_CORP')};
    return function (name) {${body[1].replace(/: string/g, '')}\n}
  `
  return new Function(code)() as (name: string) => boolean
}

const isPlausible = loadGate()

describe('会社名の検閲: 実際に登録されていた誤抽出を弾く', () => {
  // 2026-08-29 に prod で見つかった実データ（人数は直近7日）
  const NG: [string, string][] = [
    ['医療法人Sクリニックにてスタッフマネージャー兼事務担当として', '文の断片・25人'],
    ['独立行政法人向けサポートデスク案件に参画し', '文の断片'],
    ['PM・PMO・コンサル7名', '人数表現・11人'],
    ['インフラ5名', '人数表現・8人'],
    ['その他5名', '人数表現・8人'],
    ['QA/テスター', '役割のみ・9人'],
    ['31歳女性', '個人属性'],
    ['22歳女性', '個人属性'],
    ['27歳男性', '個人属性'],
    ['32歳男性', '個人属性'],
    ['10月', '日付'],
    ['ご依頼', '一般語'],
    ['フリーランス', '一般語'],
    ['dYCOy6foGK', 'ランダム文字列'],
  ]
  for (const [name, why] of NG) {
    it(`弾く: ${name}（${why}）`, () => {
      expect(isPlausible(name)).toBe(false)
    })
  }
})

describe('会社名の検閲: 実在する会社名は通す', () => {
  // 同じく prod の実データ。法人格が無い社名も多いので落としてはいけない
  const OK = [
    '株式会社ai・more',
    '株式会社アイスタンダード',
    '株式会社JapanTechnology',
    'JapanTechnology',
    'フォスターネット',
    'クリア横山',
    'クリア日野',
    'Miraie塩田',
    'ブライトスター',
    'メディアリンク',
    'ドリームビジョン',
    '㈱KICOシステムズ',
    '株式会社UNITE NEO',
    'キャル(株)',
    'Next IT Consulting株式会社',
    '株式会社Branding Engineer',
  ]
  for (const name of OK) {
    it(`通す: ${name}`, () => {
      expect(isPlausible(name)).toBe(true)
    })
  }
})

describe('会社名の検閲: 法人格があれば役割語を含んでも通す', () => {
  it('株式会社インフラソリューションズ は通す', () => {
    expect(isPlausible('株式会社インフラソリューションズ')).toBe(true)
  })
  it('「インフラ」単独は弾く', () => {
    expect(isPlausible('インフラ')).toBe(false)
  })
})

describe('会社名の検閲: 極端な長さ', () => {
  it('1文字は弾く', () => expect(isPlausible('A')).toBe(false))
  it('40文字超は弾く', () => expect(isPlausible('あ'.repeat(41))).toBe(false))
})
