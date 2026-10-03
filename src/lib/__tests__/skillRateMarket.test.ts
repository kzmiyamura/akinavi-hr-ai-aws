/**
 * 単価相場との比較（人材カードの「相場より高い/安い」表示）。
 *
 * ⚠ parseRateMan は SQL の parse_rate_man と**同じ規則**でなければならない。
 *   片方だけ直すと、画面の表示とDBの絞り込みが食い違う。
 *   SQL 側の実測（2026-09-21）:
 *     '55～60万'→55 / '55万～60万'→55 / '７５万円'→75 /
 *     '60-70万'→60 / '80万〜'→80 / '応相談'→null
 *
 * ⚠ expBand は SQL の exp_band() と**同じ切り方**でなければならない。
 *   片方だけ変えると、画面が引くキーとビューのキーが食い違って相場が出なくなる。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseRateMan, compareToMarket, expBand, marketLabel,
} from '../db/skillRateMarket'
import type {
  SkillRate, SkillExpRate, ExpRate, ExpBand, RateMarket,
} from '../db/skillRateMarket'

const skill = (s: string, median: number): SkillRate =>
  ({ skill: s, people: 50, with_rate: 50, p25: median - 10, median, p75: median + 10 })

const skillExp = (s: string, band: ExpBand, median: number, p25 = median - 10, p75 = median + 10): SkillExpRate =>
  ({ skill: s, exp_band: band, people: 30, with_rate: 30, p25, median, p75 })

const exp = (band: ExpBand, median: number): ExpRate =>
  ({ exp_band: band, people: 500, with_rate: 500, p25: median - 10, median, p75: median + 10 })

function market(over: Partial<RateMarket> = {}): RateMarket {
  return {
    bySkill: new Map([
      ['Java', skill('Java', 70)],
      ['SRE', skill('SRE', 95)],
      ['Excel', skill('Excel', 65)],
      // 本番の実測値（これが「相場75万」の出どころだった）
      ['VMware', skill('VMware', 75)],
    ]),
    bySkillExp: new Map([
      // 本番の実測（控え722人）: VMware 0〜2年 は 46/57/60
      ['VMware0-2', skillExp('VMware', '0-2', 57, 46, 60)],
      ['VMware16+', skillExp('VMware', '16+', 81, 70, 90)],
      ['Java0-2', skillExp('Java', '0-2', 50)],
      ['SRE0-2', skillExp('SRE', '0-2', 62)],
      ['Java6-10', skillExp('Java', '6-10', 70)],
    ]),
    byExp: new Map([
      ['0-2', exp('0-2', 53)],
      ['6-10', exp('6-10', 70)],
      ['16+', exp('16+', 75)],
    ]),
    ...over,
  }
}

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

describe('expBand（SQL の exp_band と同じ切り方）', () => {
  it('境目', () => {
    expect(expBand(0)).toBe('0-2')
    expect(expBand(2)).toBe('0-2')
    expect(expBand(3)).toBe('3-5')
    expect(expBand(5)).toBe('3-5')
    expect(expBand(6)).toBe('6-10')
    expect(expBand(10)).toBe('6-10')
    expect(expBand(11)).toBe('11-15')
    expect(expBand(15)).toBe('11-15')
    expect(expBand(16)).toBe('16+')
    expect(expBand(40)).toBe('16+')
  })
  it('分からないものは null（0年として扱わない）', () => {
    expect(expBand(null)).toBeNull()
    expect(expBand(undefined)).toBeNull()
    expect(expBand(NaN)).toBeNull()
  })
})

describe('TS と SQL で帯の切り方が一致している', () => {
  // ⚠ ここがズレると、画面が引くキーとビューのキーが食い違い、
  //    相場が**黙って出なくなる**（エラーにならないので気づけない）。
  //    role_affinity と同じく、両方から読み出して突き合わせる。
  const SQL = resolve(__dirname, '../../../supabase/migrations/20261003_rate_market_by_experience.sql')

  it('exp_band() の閾値と帯名が expBand と同じ', () => {
    const sql = readFileSync(SQL, 'utf8')
    const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.exp_band[\s\S]*?\$\$([\s\S]*?)\$\$/)
    expect(fn, 'exp_band() を migration から取り出せませんでした').not.toBeNull()

    // `WHEN years <  3 THEN '0-2'` の並びを読む
    const steps = [...fn![1].matchAll(/WHEN\s+years\s*<\s*(\d+)\s*THEN\s*'([^']+)'/g)]
      .map((m) => ({ lt: Number(m[1]), band: m[2] }))
    const elseBand = fn![1].match(/ELSE\s+'([^']+)'/)?.[1]
    expect(steps.length, 'SQL 側の WHEN が読めていません').toBeGreaterThan(0)
    expect(elseBand).toBeTruthy()

    // 各境目の直前・直後で TS 側が同じ帯を返すか
    for (const { lt, band } of steps) {
      expect(expBand(lt - 1), `${lt - 1}年`).toBe(band)
    }
    const last = steps[steps.length - 1].lt
    expect(expBand(last), `${last}年は ELSE の帯`).toBe(elseBand)
    // null の扱いも合わせる（SQL は NULL→NULL）
    expect(fn![1]).toContain('years IS NULL')
    expect(expBand(null)).toBeNull()
  })

  it('ビューが返す帯名を全部 expBand が作れる（キーの取りこぼしが無い）', () => {
    const sql = readFileSync(SQL, 'utf8')
    const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.exp_band[\s\S]*?\$\$([\s\S]*?)\$\$/)![1]
    const sqlBands = new Set([...fn.matchAll(/'([\d+\-]+)'/g)].map((m) => m[1]))
    const tsBands = new Set([0, 3, 6, 11, 16, 50].map((y) => expBand(y)))
    for (const b of sqlBands) expect(tsBands, `SQL の帯 ${b}`).toContain(b)
  })
})

describe('2026-10-03 に画面で誤解を生んだケース', () => {
  it('23歳・経験1年・VMware・希望50万 → 相場は75万ではなく57万', () => {
    const r = compareToMarket('50万', ['VMware'], 1, market())
    expect(r).not.toBeNull()
    expect(r!.basis).toBe('skill-exp')
    expect(r!.band).toBe('0-2')
    expect(r!.median).toBe(57)
    expect(r!.diff).toBe(-7)          // 以前は -25 と出ていた
    expect(r!.withinQuartiles).toBe(true)   // 46〜60 の中。「安い」と言うべきではない
    expect(marketLabel(r!)).toBe('相場57万（VMware・経験0〜2年）')
  })

  it('同じ人材でもベテランなら厳しく出る（帯が効いている証拠）', () => {
    const r = compareToMarket('50万', ['VMware'], 20, market())
    expect(r!.band).toBe('16+')
    expect(r!.median).toBe(81)
    expect(r!.diff).toBe(-31)
    expect(r!.withinQuartiles).toBe(false)
  })
})

describe('基準の選び方', () => {
  it('本人の経験帯のまま、一番高い相場のスキルを採る（武器は借りるが年次は盛らない）', () => {
    // Java 0-2 は50万、SRE 0-2 は62万。高い方の SRE で語る
    const r = compareToMarket('70万', ['Java', 'SRE'], 1, market())
    expect(r!.skill).toBe('SRE')
    expect(r!.band).toBe('0-2')
    expect(r!.median).toBe(62)
  })

  it('そのスキルの帯が20人に届かないときは帯だけの相場に落とす', () => {
    // Excel には帯別のセットが無い
    const r = compareToMarket('60万', ['Excel'], 1, market())
    expect(r!.basis).toBe('exp')
    expect(r!.skill).toBeNull()
    expect(r!.median).toBe(53)
    expect(marketLabel(r!)).toBe('相場53万（経験0〜2年・全スキル）')
  })

  it('経験年数が不明なときは従来どおりスキル単位（根拠が弱いとラベルに出す）', () => {
    const r = compareToMarket('80万', ['Java', 'SRE'], null, market())
    expect(r!.basis).toBe('skill')
    expect(r!.skill).toBe('SRE')
    expect(r!.median).toBe(95)
    expect(r!.band).toBeNull()
    expect(marketLabel(r!)).toBe('相場95万（SRE・経験不明）')
  })

  it('経験年数が分かっていても帯の相場が無ければスキル単位に落ちる', () => {
    const m = market({ byExp: new Map() })
    const r = compareToMarket('80万', ['Excel'], 1, m)
    expect(r!.basis).toBe('skill')
    expect(r!.median).toBe(65)
  })
})

describe('相場の幅（25〜75%）', () => {
  it('幅の中なら withinQuartiles が true', () => {
    const r = compareToMarket('55万', ['VMware'], 1, market())   // 46〜60 の中
    expect(r!.withinQuartiles).toBe(true)
  })
  it('幅の外なら false', () => {
    const r = compareToMarket('30万', ['VMware'], 1, market())
    expect(r!.withinQuartiles).toBe(false)
  })
  it('母数を持っている（少ない相場を強い根拠に見せない）', () => {
    expect(compareToMarket('50万', ['VMware'], 1, market())!.people).toBe(30)
    expect(compareToMarket('60万', ['Excel'], 1, market())!.people).toBe(500)
  })
})

describe('比較しない場合', () => {
  it('相場のあるスキルを持たず、帯の相場も無い', () => {
    expect(compareToMarket('80万', ['COBOL'], null, market())).toBeNull()
  })
  it('単価が読めない', () => {
    expect(compareToMarket('応相談', ['Java'], 5, market())).toBeNull()
    expect(compareToMarket(null, ['Java'], 5, market())).toBeNull()
  })
  it('相場表が無い・スキルが空でも落ちない', () => {
    expect(compareToMarket('80万', ['Java'], 5, undefined)).toBeNull()
    expect(compareToMarket('80万', [], null, market())).toBeNull()
    expect(compareToMarket('80万', null, null, market())).toBeNull()
  })
  it('スキルが空でも経験年数が分かれば帯で比較できる', () => {
    const r = compareToMarket('60万', [], 8, market())
    expect(r!.basis).toBe('exp')
    expect(r!.median).toBe(70)
  })
})
