import { describe, it, expect } from 'vitest'
import { pgSkillWordPattern, skillFilterOrTerms, matchesSkillFilter } from '../skillWordMatch'
// ワーカー側（node）の実装。二重管理なので、生成するパターンが一致することをここで担保する
// @ts-expect-error 型定義のない素の JS モジュール（実行は vitest のみ）
import { pgSkillWordPattern as workerPattern } from '../../../scripts/llm_extract/shadow_worker_lib.mjs'

describe('pgSkillWordPattern', () => {
  const hit = (skill: string, text: string) =>
    new RegExp(pgSkillWordPattern(skill)!, 'i').test(text)

  it('Java は JavaScript を拾わない', () => {
    expect(hit('Java', 'JavaScript、jQuery、Figma')).toBe(false)
    expect(hit('Java', 'Java / Spring Boot')).toBe(true)
    expect(hit('Java', 'Java経験5年')).toBe(true)
  })

  it('C は C# / C++ を拾わない', () => {
    expect(hit('C', 'C#, VB.net')).toBe(false)
    expect(hit('C', 'C++ での開発')).toBe(false)
    expect(hit('C#', 'C#.NET 開発')).toBe(true)
  })

  it('ドットが任意1文字にならない', () => {
    expect(hit('.NET', '使用: .NET Framework')).toBe(true)
    expect(hit('.NET', '使用: XNET')).toBe(false)
  })

  it('表現できない名前は null', () => {
    expect(pgSkillWordPattern('a\\b')).toBeNull()
  })
})

describe('ワーカーとの同期', () => {
  it('同じパターンを生成する', () => {
    for (const s of ['Java', 'C#', 'C++', '.NET', 'Spring Boot', 'a\\b']) {
      expect(pgSkillWordPattern(s)).toEqual(workerPattern(s))
    }
  })
})

describe('skillFilterOrTerms', () => {
  it('skills 列と本文の2条件を出す', () => {
    const terms = skillFilterOrTerms(['Java'])
    expect(terms).toHaveLength(2)
    expect(terms[0]).toBe('skills.cs.["Java"]')
    // 正規表現は括弧を含むので二重引用符で囲む（PostgREST の or() 構文と切り分け）
    expect(terms[1]).toMatch(/^raw_profile->>text\.imatch\.".+"$/)
  })

  it('表現できない名前は部分一致に退避する', () => {
    expect(skillFilterOrTerms(['a\\b'])[1]).toContain('ilike')
  })
})

describe('matchesSkillFilter', () => {
  it('skills 列の完全一致で該当', () => {
    expect(matchesSkillFilter(['Java'], ['Java', 'SQL'], null)).toBe(true)
    expect(matchesSkillFilter(['Java'], ['JavaScript'], null)).toBe(false)
  })

  it('本文は語一致のみ（JavaScript だけの人は対象外）', () => {
    expect(matchesSkillFilter(['Java'], [], 'JavaScript、jQuery、Figma')).toBe(false)
    expect(matchesSkillFilter(['Java'], [], 'Java および Spring')).toBe(true)
  })

  it('本文が無ければ skills 列だけで判定する', () => {
    expect(matchesSkillFilter(['Java'], ['C#'], null)).toBe(false)
  })
})
