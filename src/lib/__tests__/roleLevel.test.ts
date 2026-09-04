import { describe, it, expect } from 'vitest'
import { readRoleLevel, roleLevelNote, rateMismatch, parseRateWan } from '../roleLevel'

describe('readRoleLevel', () => {
  it('raw_profile._roleLevels からその役割のレベルを読む', () => {
    const rp = { _roleLevels: { PMO: 'A', プロジェクトマネージャー: 'C' } }
    expect(readRoleLevel(rp, 'PMO')).toBe('A')
    expect(readRoleLevel(rp, 'プロジェクトマネージャー')).toBe('C')
  })

  it('判定対象外の役割は null（意味のない印を出さない）', () => {
    expect(readRoleLevel({ _roleLevels: { PMO: 'A' } }, '運用保守')).toBeNull()
  })

  it('_roleLevels が無い既存データでも落ちない', () => {
    expect(readRoleLevel({ roles: ['PMO'] }, 'PMO')).toBeNull()
    expect(readRoleLevel(null, 'PMO')).toBeNull()
    expect(readRoleLevel({ _roleLevels: 'こわれた値' }, 'PMO')).toBeNull()
  })

  it('想定外の値は採らない', () => {
    expect(readRoleLevel({ _roleLevels: { PMO: 'S' } }, 'PMO')).toBeNull()
  })
})

describe('parseRateWan', () => {
  it('複数書いてあるときは高い方を採る（match-batch と同じ考え方）', () => {
    expect(parseRateWan('55万円以上希望（PMOなどは67万円）')).toBe(67)
  })
  it('稼働時間は「万」が付かないので混ざらない', () => {
    expect(parseRateWan('80万（140〜180h）')).toBe(80)
  })
  it('読めないものは null', () => {
    expect(parseRateWan('応相談')).toBeNull()
    expect(parseRateWan(null)).toBeNull()
  })
})

describe('rateMismatch', () => {
  it('C級（事務局作業どまり）で80万以上なら警告する', () => {
    const r = rateMismatch('C', '85万')
    expect(r).not.toBeNull()
    expect(r!.note).toContain('85万')
    expect(r!.note).toContain('従事レベル')
  })

  it('「－ 裏付けなし」は警告しない（実測で誤報と分かった）', () => {
    // 裏付けなし群は PM併記64.9%・カネヒト言及82.5%・平均75万で C級(67万)より上。
    // 実力が無いのではなく、その役割としての記述が無い＝ラベルが当てにならないだけ
    expect(rateMismatch('-', '90万')).toBeNull()
  })

  it('A級・B級は単価が高くても警告しない（本物なので）', () => {
    expect(rateMismatch('A', '120万')).toBeNull()
    expect(rateMismatch('B', '95万')).toBeNull()
  })

  it('C級でも単価が低ければ矛盾ではない', () => {
    expect(rateMismatch('C', '60万')).toBeNull()
  })

  it('単価が読めないときは警告しない（憶測で落とさない）', () => {
    expect(rateMismatch('C', '応相談')).toBeNull()
    expect(rateMismatch(null, '100万')).toBeNull()
  })
})

describe('roleLevelNote', () => {
  it('判定の根拠（実測の単価分布）まで出す', () => {
    const note = roleLevelNote('PMO', 'C')
    expect(note).toContain('議事録')
    expect(note).toContain('A級97万')
  })
  it('実測が無い役割でも意味だけは出す', () => {
    expect(roleLevelNote('アーキテクト', 'A')).toContain('全体最適')
  })
})
