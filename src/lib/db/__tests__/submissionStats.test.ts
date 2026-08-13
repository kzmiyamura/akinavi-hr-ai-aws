import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()

vi.mock('../../supabase', () => ({
  supabase: {
    rpc: mockRpc,
  },
}))

describe('fetchSubmissionStats', () => {
  beforeEach(() => {
    vi.resetModules()
    mockRpc.mockReset()
  })

  it('案件別・人材別に件数とAI採点件数を集計する', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { kind: 'project', ref_id: 'p1', n: 2, n_ai: 1 },
        { kind: 'project', ref_id: 'p2', n: 1, n_ai: 0 },
        { kind: 'candidate', ref_id: 'c1', n: 2, n_ai: 2 },
        { kind: 'candidate', ref_id: 'c2', n: 1, n_ai: 0 },
      ],
      error: null,
    })

    const { fetchSubmissionStats } = await import('../submissions')
    const s = await fetchSubmissionStats('prod')

    expect(mockRpc).toHaveBeenCalledWith('submission_counts', { p_data_env: 'prod' })
    expect(s.countByProjectId.p1).toBe(2)
    expect(s.countByProjectId.p2).toBe(1)
    expect(s.countByCandidateId.c1).toBe(2)
    expect(s.countByCandidateId.c2).toBe(1)
    expect(s.aiCountByProjectId.p1).toBe(1)
    expect(s.aiCountByProjectId.p2).toBe(0)
    expect(s.aiCountByCandidateId.c1).toBe(2)
  })

  it('Supabase エラー時は例外', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'x' } })
    const { fetchSubmissionStats } = await import('../submissions')
    await expect(fetchSubmissionStats('prod')).rejects.toThrow('提案履歴の集計に失敗しました')
  })
})
