/**
 * 人材分布マップの「最近絞り込んだスキル」の回帰テスト。
 *
 * 端末（localStorage）に持つ設定なので、壊れた値が入っていても画面を落とさないこと、
 * 打った表記をそのまま出すこと（「Java」が「java」に化けない）を固定する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RECENT_SKILL_LIMIT,
  normalizeRecentSkills,
  pushRecentSkill,
  readRecentSkills,
  writeRecentSkills,
} from '../recentSkillFilters'

const KEY = 'akinavi.recentSkillFilters.v1'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('normalizeRecentSkills', () => {
  it('空文字と空白だけの値を落とす', () => {
    expect(normalizeRecentSkills(['Java', '', '   ', 'Go'])).toEqual(['Java', 'Go'])
  })

  it('前後の空白を落とす', () => {
    expect(normalizeRecentSkills(['  Java  '])).toEqual(['Java'])
  })

  it('大小が違うだけの重複は先に出た表記で1つに畳む', () => {
    expect(normalizeRecentSkills(['Java', 'java', 'JAVA'])).toEqual(['Java'])
  })

  it('上限まで（新しい順）', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(normalizeRecentSkills(many)).toEqual(many.slice(0, RECENT_SKILL_LIMIT))
  })

  it('数値や null が混ざっていても落ちない', () => {
    expect(normalizeRecentSkills([null, undefined, 0, 'Java'])).toEqual(['0', 'Java'])
  })
})

describe('pushRecentSkill', () => {
  it('新しいものが先頭に来る', () => {
    expect(pushRecentSkill(['Go', 'Rust'], 'Java')).toEqual(['Java', 'Go', 'Rust'])
  })

  it('すでにある項目を使い直すと先頭に上がる（増えない）', () => {
    expect(pushRecentSkill(['Go', 'Rust'], 'Rust')).toEqual(['Rust', 'Go'])
  })

  it('大小が違う表記で使い直したら、新しく打った表記になる', () => {
    expect(pushRecentSkill(['Java'], 'JAVA')).toEqual(['JAVA'])
  })

  it('空文字は履歴を変えない', () => {
    expect(pushRecentSkill(['Go'], '  ')).toEqual(['Go'])
  })

  it('上限を超えたら古いものから落ちる', () => {
    const full = ['a', 'b', 'c', 'd', 'e']
    expect(pushRecentSkill(full, 'f')).toEqual(['f', 'a', 'b', 'c', 'd'])
  })
})

describe('読み書き', () => {
  it('書いたものが読める', () => {
    writeRecentSkills(['Java', 'Go'])
    expect(readRecentSkills()).toEqual(['Java', 'Go'])
  })

  it('未保存なら空', () => {
    expect(readRecentSkills()).toEqual([])
  })

  it('壊れた JSON でも空を返す（画面を落とさない）', () => {
    localStorage.setItem(KEY, '{壊れている')
    expect(readRecentSkills()).toEqual([])
  })

  it('配列でない値が入っていても空を返す', () => {
    localStorage.setItem(KEY, '{"skills":["Java"]}')
    expect(readRecentSkills()).toEqual([])
  })

  it('localStorage が使えなくても投げない（プライベートブラウズ）', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeRecentSkills(['Java'])).not.toThrow()
  })
})
