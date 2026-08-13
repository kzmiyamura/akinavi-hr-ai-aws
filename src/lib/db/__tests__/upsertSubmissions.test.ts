import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UpsertSubmissionInput } from '../submissions'

const mockUpsert = vi.fn()

vi.mock('../../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ upsert: mockUpsert })),
  },
}))

function inputs(n: number): UpsertSubmissionInput[] {
  return Array.from({ length: n }, (_, i) => ({
    candidateId: `c${i}`,
    projectId: 'p1',
    matchResult: { score: i, summary: '', duplicateSuspected: false, ruleScore: i },
    breakdown: `内訳${i}`,
    createdBy: 'miya',
    dataEnv: 'prod' as const,
  }))
}

describe('upsertSubmissions', () => {
  beforeEach(() => {
    vi.resetModules()
    mockUpsert.mockReset()
    mockUpsert.mockResolvedValue({ error: null })
  })

  it('200件ごとにまとめて保存する（1件ずつ往復しない）', async () => {
    const { upsertSubmissions } = await import('../submissions')
    await upsertSubmissions(inputs(450))

    expect(mockUpsert).toHaveBeenCalledTimes(3)
    expect(mockUpsert.mock.calls[0][0]).toHaveLength(200)
    expect(mockUpsert.mock.calls[1][0]).toHaveLength(200)
    expect(mockUpsert.mock.calls[2][0]).toHaveLength(50)
    expect(mockUpsert.mock.calls[0][1]).toEqual({ onConflict: 'candidate_id,project_id' })
  })

  it('内訳とルールスコアを ai_raw に入れる', async () => {
    const { upsertSubmissions } = await import('../submissions')
    await upsertSubmissions(inputs(1))

    const row = mockUpsert.mock.calls[0][0][0]
    expect(row.candidate_id).toBe('c0')
    expect(row.ai_raw).toEqual({ duplicateSuspected: false, ruleScore: 0, breakdown: '内訳0' })
  })

  it('0件なら何もしない', async () => {
    const { upsertSubmissions } = await import('../submissions')
    await upsertSubmissions([])
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('保存エラーは例外にする', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'x' } })
    const { upsertSubmissions } = await import('../submissions')
    await expect(upsertSubmissions(inputs(1))).rejects.toThrow('提案履歴の保存に失敗しました')
  })
})
