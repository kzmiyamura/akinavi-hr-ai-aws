/**
 * 会社名の正規化。表記ゆれで同じ会社が別会社として扱われていた問題の回帰テスト。
 * 実データ（2026-08-29・prod）の表記を使う。
 */
import { describe, it, expect } from 'vitest'
import { normalizeCompany, isSameCompany } from '../companyName'

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
