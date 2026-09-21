/**
 * 単価相場との比較（人材カードの「相場より高い/安い」表示）。
 *
 * ⚠ parseRateMan は SQL の parse_rate_man と**同じ規則**でなければならない。
 *   片方だけ直すと、画面の表示とDBの絞り込みが食い違う。
 *   SQL 側の実測（2026-09-21）:
 *     '55～60万'→55 / '55万～60万'→55 / '７５万円'→75 /
 *     '60-70万'→60 / '80万〜'→80 / '応相談'→null
 */
import { describe, it, expect } from 'vitest'
import { parseRateMan, compareToMarket } from '../db/skillRateMarket'
import type { SkillRate } from '../db/skillRateMarket'

const mk = (skill: string, median: number): SkillRate =>
  ({ skill, people: 50, with_rate: 50, p25: median - 10, median, p75: median + 10 })

describe('parseRateMan（SQL の parse_rate_man と同じ規則）', () => {
  it('SQL 側の実測値と一致する', () => {
    expect(parseRateMan('55～60万')).toBe(55)
    expect(parseRateMan('55万～60万')).toBe(55)
    expect(parseRateMan('７５万円')).toBe(75)
    expect(parseRateMan('60-70万')).toBe(60)
    expect(parseRateMan('80万〜')).toBe(80)
    expect(parseRateMan('応相談')).toBeNull()
  })

  it('範囲は下限を採る（上限を採ると高く見えて交渉を誤る）', () => {
    expect(parseRateMan('70～90万')).toBe(70)
  })

  it('人として有り得ない値は拾わない', () => {
    expect(parseRateMan('10万')).toBeNull()      // 20万未満
    expect(parseRateMan('500万')).toBeNull()     // 300万超
    expect(parseRateMan('')).toBeNull()
    expect(parseRateMan(null)).toBeNull()
    expect(parseRateMan(undefined)).toBeNull()
  })
})

describe('compareToMarket', () => {
  const market = new Map<string, SkillRate>([
    ['Java', mk('Java', 70)],
    ['SRE', mk('SRE', 95)],
    ['Excel', mk('Excel', 65)],
  ])

  it('一番高い相場のスキルを基準にする（営業が持ち出す武器）', () => {
    const r = compareToMarket('80万', ['Java', 'SRE', 'Excel'], market)
    expect(r).not.toBeNull()
    expect(r!.skill).toBe('SRE')
    expect(r!.median).toBe(95)
    expect(r!.diff).toBe(-15)   // 相場より15万安い＝通しやすい
  })

  it('相場より高い人は正の差が出る', () => {
    const r = compareToMarket('90万', ['Java'], market)
    expect(r!.diff).toBe(20)
  })

  it('相場のあるスキルを持っていなければ比較しない', () => {
    expect(compareToMarket('80万', ['COBOL'], market)).toBeNull()
  })

  it('単価が読めなければ比較しない', () => {
    expect(compareToMarket('応相談', ['Java'], market)).toBeNull()
    expect(compareToMarket(null, ['Java'], market)).toBeNull()
  })

  it('相場表が無い・スキルが空でも落ちない', () => {
    expect(compareToMarket('80万', ['Java'], undefined)).toBeNull()
    expect(compareToMarket('80万', [], market)).toBeNull()
    expect(compareToMarket('80万', null, market)).toBeNull()
  })
})
