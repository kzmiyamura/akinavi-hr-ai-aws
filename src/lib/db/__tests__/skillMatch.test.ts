import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSkillMatcher, NO_MATCHES, fetchSkillMatches } from '../skillMatch'

vi.mock('../../supabase', () => ({
  supabase: { rpc: vi.fn() },
}))

const { supabase } = await import('../../supabase')
const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

describe('buildSkillMatcher', () => {
  it('サーバが返した組だけを一致とみなす', () => {
    const m = buildSkillMatcher([
      { have: 'MySQL', want: 'SQL' },
      { have: 'Java', want: 'Java' },
    ])
    expect(m('MySQL', 'SQL')).toBe(true)
    expect(m('Java', 'Java')).toBe(true)
    // 画面側で部分一致を補わないこと（JavaScript は Java 要件を満たさない）
    expect(m('JavaScript', 'Java')).toBe(false)
    expect(m('Shell', 'PowerShell')).toBe(false)
  })

  it('大文字小文字の違いを吸収する', () => {
    const m = buildSkillMatcher([{ have: 'Spring Boot', want: 'Spring' }])
    expect(m('spring boot', 'SPRING')).toBe(true)
  })

  it('向きを保つ（SQL を持つ人が MySQL 要件を満たすわけではない）', () => {
    const m = buildSkillMatcher([{ have: 'MySQL', want: 'SQL' }])
    expect(m('SQL', 'MySQL')).toBe(false)
  })

  it('NO_MATCHES は常に false', () => {
    expect(NO_MATCHES('Java', 'Java')).toBe(false)
  })
})

describe('fetchSkillMatches', () => {
  beforeEach(() => rpc.mockReset())

  it('重複を除いてから問い合わせる', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await fetchSkillMatches(['Java', 'Java', ' Java ', ''], ['SQL', 'SQL'])
    expect(rpc).toHaveBeenCalledWith('match_skill_strings', {
      p_have: ['Java'],
      p_want: ['SQL'],
    })
  })

  it('どちらかが空なら問い合わせない', async () => {
    const m = await fetchSkillMatches([], ['SQL'])
    expect(rpc).not.toHaveBeenCalled()
    expect(m('SQL', 'SQL')).toBe(false)
  })

  it('エラーはそのまま投げる（緑表示を捏造しない）', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('boom') })
    await expect(fetchSkillMatches(['Java'], ['Java'])).rejects.toThrow('boom')
  })
})
