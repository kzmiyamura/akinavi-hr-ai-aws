/**
 * 会社名の正規化。表記ゆれで同じ会社が別会社として扱われていた問題の回帰テスト。
 * 実データ（2026-08-29・prod）の表記を使う。
 */
import { describe, it, expect } from 'vitest'
import { normalizeCompany, isSameCompany, keepOtherCompanyOnly } from '../companyName'

describe('normalizeCompany', () => {
  it('法人格の有無を吸収する', () => {
    expect(normalizeCompany('株式会社JapanTechnology')).toBe(normalizeCompany('JapanTechnology'))
  })
  it('前株・後株を吸収する', () => {
    expect(normalizeCompany('株式会社サクヤ')).toBe(normalizeCompany('サクヤ株式会社'))
  })
  it('㈱・(株)・（株）を吸収する', () => {
    const base = normalizeCompany('株式会社KICOシステムズ')
    expect(normalizeCompany('㈱KICOシステムズ')).toBe(base)
    expect(normalizeCompany('(株)KICOシステムズ')).toBe(base)
    expect(normalizeCompany('（株）KICOシステムズ')).toBe(base)
  })
  it('英語の法人格を吸収する', () => {
    expect(normalizeCompany('Next IT Consulting株式会社')).toBe(normalizeCompany('Next IT Consulting Inc.'))
  })
  it('全角英数を半角に揃える', () => {
    expect(normalizeCompany('ＵＮＩＴＥ ＮＥＯ')).toBe(normalizeCompany('UNITE NEO'))
  })
  it('空白・中黒の違いを吸収する', () => {
    expect(normalizeCompany('株式会社ai・more')).toBe(normalizeCompany('株式会社ai more'))
    expect(normalizeCompany('株式会社UNITE NEO')).toBe(normalizeCompany('株式会社UNITENEO'))
  })
  it('空・null は空文字', () => {
    expect(normalizeCompany(null)).toBe('')
    expect(normalizeCompany(undefined)).toBe('')
    expect(normalizeCompany('  ')).toBe('')
  })
})

describe('isSameCompany', () => {
  it('表記が違っても同じ会社なら true', () => {
    expect(isSameCompany('JapanTechnology', '株式会社JapanTechnology')).toBe(true)
    expect(isSameCompany('ブライトスター', '株式会社ブライトスター')).toBe(true)
    expect(isSameCompany('フォスターネット', '株式会社フォスターネット')).toBe(true)
  })
  it('違う会社は false', () => {
    expect(isSameCompany('株式会社ai・more', '株式会社アイスタンダード')).toBe(false)
    expect(isSameCompany('クリア横山', 'クリア日野')).toBe(false)
  })
  it('片方が空なら false（不明どうしを同じ会社にしない）', () => {
    expect(isSameCompany(null, '株式会社ai・more')).toBe(false)
    expect(isSameCompany(null, null)).toBe(false)
    expect(isSameCompany('', '')).toBe(false)
  })
  it('法人格だけの文字列どうしは同じ会社にしない', () => {
    expect(isSameCompany('株式会社', '株式会社')).toBe(false)
  })
})

describe('keepOtherCompanyOnly', () => {
  const list = [
    { id: 'a', from_company: '株式会社JapanTechnology' },
    { id: 'b', from_company: 'JapanTechnology' },
    { id: 'c', from_company: '株式会社ブライトスター' },
    { id: 'd', from_company: null },
  ]

  it('同じ会社のレコードを落とす（法人格の有無を無視して）', () => {
    expect(keepOtherCompanyOnly(list, 'JapanTechnology').map((d) => d.id)).toEqual(['c', 'd'])
  })

  it('会社名が取れていない相手は残す（同社と断定できないため）', () => {
    expect(keepOtherCompanyOnly(list, '株式会社ブライトスター').map((d) => d.id))
      .toEqual(['a', 'b', 'd'])
  })

  it('自分の会社が不明なら1件も落とさない', () => {
    expect(keepOtherCompanyOnly(list, null)).toHaveLength(4)
  })

  it('全部同じ会社なら空になる（呼び出し側は見出しごと出さない）', () => {
    expect(keepOtherCompanyOnly(
      [{ from_company: '㈱JapanTechnology' }, { from_company: 'Japan Technology' }],
      '株式会社JapanTechnology',
    )).toEqual([])
  })
})

/**
 * 取り込み時（inbound-email）の同社判定が、表示側と同じ規則で正規化しているか。
 * 手写しのレプリカは作らず、本番に出す index.ts から式を切り出して照合する。
 */
describe('inbound-email の会社名正規化が companyName.ts と一致する', () => {
  it('同じ入力から同じキーを作る', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(
      resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'), 'utf8')
    const m = src.match(
      /const norm = \(v: string \| null \| undefined\) =>\s*([\s\S]*?\.toLowerCase\(\))/)
    if (!m) throw new Error('inbound-email の norm を切り出せませんでした')
    const inboundNorm = new Function('v', `return ${m[1]};`) as (v: unknown) => string

    for (const name of [
      '株式会社JapanTechnology', 'JapanTechnology', '㈱KICOシステムズ',
      'Next IT Consulting Inc.', 'ＵＮＩＴＥ ＮＥＯ', '株式会社ai・more', null,
    ]) {
      expect(inboundNorm(name)).toBe(normalizeCompany(name))
    }
  })
})
