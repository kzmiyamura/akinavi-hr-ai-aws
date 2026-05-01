import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelectStats = vi.fn()

vi.mock('../../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: mockSelectStats,
    })),
  },
}))

describe('fetchSubmissionStats', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSelectStats.mockReset()
  })

  it('案件別・人材別に件数を集計する', async () => {
    mockSelectStats.mockResolvedValue({
      data: [
        { project_id: 'p1', candidate_id: 'c1' },
        { project_id: 'p1', candidate_id: 'c2' },
        { project_id: 'p2', candidate_id: 'c1' },
      ],
      error: null,
    })

    const { fetchSubmissionStats } = await import('../submissions')
    const s = await fetchSubmissionStats()

    expect(s.countByProjectId.p1).toBe(2)
    expect(s.countByProjectId.p2).toBe(1)
    expect(s.countByCandidateId.c1).toBe(2)
    expect(s.countByCandidateId.c2).toBe(1)
  })

  it('Supabase エラー時は例外', async () => {
    mockSelectStats.mockResolvedValue({ data: null, error: { message: 'x' } })
    const { fetchSubmissionStats } = await import('../submissions')
    await expect(fetchSubmissionStats()).rejects.toThrow('提案履歴の集計に失敗しました')
  })
})
