import { describe, it, expect } from 'vitest'
import { findSkillMonths } from './skillYearsMatch'

describe('findSkillMonths', () => {
  it('完全一致でマッチする', () => {
    expect(findSkillMonths({ Java: 120 }, 'Java')).toBe(120)
    expect(findSkillMonths({ java: 120 }, 'JAVA')).toBe(120)
  })

  it('Java キーが JavaScript にマッチしない（IM実害）', () => {
    expect(findSkillMonths({ Java: 120 }, 'JavaScript')).toBeNull()
  })

  it('JavaScript キーが Java にマッチしない（逆方向）', () => {
    expect(findSkillMonths({ JavaScript: 36 }, 'Java')).toBeNull()
  })

  it('単語境界付きの部分一致は通る（SQL ⊂ SQL Server）', () => {
    expect(findSkillMonths({ SQL: 60 }, 'SQL Server')).toBe(60)
    expect(findSkillMonths({ 'SQL Server': 60 }, 'SQL')).toBe(60)
  })

  it('空白の有無を無視して完全一致する', () => {
    expect(findSkillMonths({ 'SQL Server': 60 }, 'SQLServer')).toBe(60)
  })

  it('2文字以下の短いキーは部分一致しない（C ⊂ C++ 等の誤爆防止）', () => {
    expect(findSkillMonths({ C: 60 }, 'C++')).toBeNull()
    expect(findSkillMonths({ 'C++': 60 }, 'C')).toBeNull()
  })

  it('内部キー（_プレフィックス）は無視する', () => {
    expect(findSkillMonths({ _totalProjectMonths: 144 }, 'total')).toBeNull()
  })

  it('null/undefined は null を返す', () => {
    expect(findSkillMonths(null, 'Java')).toBeNull()
    expect(findSkillMonths(undefined, 'Java')).toBeNull()
  })
})
