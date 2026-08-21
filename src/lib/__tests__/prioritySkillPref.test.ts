import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_PRIORITY_SKILL_PREF,
  normalizePrioritySkills,
  readPrioritySkillPref,
  writePrioritySkillPref,
  resolvePrioritySkills,
} from '../prioritySkillPref'

const STORAGE_KEY = 'akinavi.prioritySkills.v1'

describe('normalizePrioritySkills', () => {
  it('前後空白・空文字・重複を落とす', () => {
    expect(normalizePrioritySkills([' Java ', '', 'Java', 'AWS', '  '])).toEqual(['Java', 'AWS'])
  })
  it('大小の違いは別物として残す（skill_master の別名照合はサーバー側の仕事）', () => {
    expect(normalizePrioritySkills(['java', 'Java'])).toEqual(['java', 'Java'])
  })
  it('文字列以外が混ざっても落ちない', () => {
    expect(normalizePrioritySkills([null, undefined, 3, 'Go'])).toEqual(['3', 'Go'])
  })
})

describe('readPrioritySkillPref / writePrioritySkillPref', () => {
  beforeEach(() => { localStorage.clear() })

  it('未保存なら既定（設定画面に従う・絞り込みON）', () => {
    expect(readPrioritySkillPref()).toEqual(DEFAULT_PRIORITY_SKILL_PREF)
  })

  it('保存した値を読み戻せる', () => {
    writePrioritySkillPref({ enabled: false, skills: ['Java', 'AWS'] })
    expect(readPrioritySkillPref()).toEqual({ enabled: false, skills: ['Java', 'AWS'] })
  })

  it('空配列（この端末では優先スキルなし）と null（既定に従う）を区別して保存する', () => {
    writePrioritySkillPref({ enabled: true, skills: [] })
    expect(readPrioritySkillPref().skills).toEqual([])
    writePrioritySkillPref({ enabled: true, skills: null })
    expect(readPrioritySkillPref().skills).toBeNull()
  })

  it('保存時にも正規化する', () => {
    writePrioritySkillPref({ enabled: true, skills: [' Java ', 'Java', ''] })
    expect(readPrioritySkillPref().skills).toEqual(['Java'])
  })

  it('壊れた JSON は既定に戻す', () => {
    localStorage.setItem(STORAGE_KEY, '{壊れている')
    expect(readPrioritySkillPref()).toEqual(DEFAULT_PRIORITY_SKILL_PREF)
  })

  it('想定外の形（配列・欠損キー）でも既定の挙動に倒す', () => {
    localStorage.setItem(STORAGE_KEY, '["Java"]')
    expect(readPrioritySkillPref()).toEqual(DEFAULT_PRIORITY_SKILL_PREF)
    localStorage.setItem(STORAGE_KEY, '{"skills":"Java"}')
    expect(readPrioritySkillPref()).toEqual({ enabled: true, skills: null })
  })
})

describe('resolvePrioritySkills', () => {
  const settings = ['Salesforce']

  it('既定（skills=null）は設定画面の値を使う', () => {
    expect(resolvePrioritySkills({ enabled: true, skills: null }, settings)).toEqual(['Salesforce'])
  })

  it('端末の上書きがあれば設定画面より優先する', () => {
    expect(resolvePrioritySkills({ enabled: true, skills: ['Java'] }, settings)).toEqual(['Java'])
  })

  it('端末で空配列にしたら設定画面の値に戻さず「絞り込みなし」', () => {
    expect(resolvePrioritySkills({ enabled: true, skills: [] }, settings)).toBeNull()
  })

  it('トグル OFF なら上書きがあっても絞り込まない', () => {
    expect(resolvePrioritySkills({ enabled: false, skills: ['Java'] }, settings)).toBeNull()
  })

  it('設定画面が未設定で端末も既定なら絞り込みなし', () => {
    expect(resolvePrioritySkills({ enabled: true, skills: null }, null)).toBeNull()
    expect(resolvePrioritySkills({ enabled: true, skills: null }, [])).toBeNull()
  })
})
