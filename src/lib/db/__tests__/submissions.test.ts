import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MatchResponse } from '../../ai/types'

const mockSingle = vi.fn()
const mockSelect = vi.fn(() => ({ single: mockSingle }))
const mockUpsert = vi.fn(() => ({ select: mockSelect }))

vi.mock('../../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      upsert: mockUpsert,
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      })),
    })),
  },
}))

const mockMatchResult: MatchResponse = {
  score: 85,
  summary: 'Java・AWS のスキルが高度に一致',
  duplicateSuspected: false,
}

const mockSubmission = {
  id: 'sub-uuid-1',
  data_env: 'prod',
  candidate_id: 'cand-uuid-1',
  project_id: 'proj-uuid-1',
  match_score: 85,
  ai_summary: 'Java・AWS のスキルが高度に一致',
  ai_raw: { duplicateSuspected: false },
  status: 'pending',
  created_by: 'テストユーザー',
  created_at: '2026-04-30T00:00:00Z',
  updated_at: '2026-04-30T00:00:00Z',
}

describe('upsertSubmission', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSingle.mockReset()
    mockUpsert.mockReset()
    mockUpsert.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ single: mockSingle })
  })

  it('マッチング結果を正しく保存し、submission を返す', async () => {
    mockSingle.mockResolvedValueOnce({ data: mockSubmission, error: null })

    const { upsertSubmission } = await import('../submissions')
    const result = await upsertSubmission({
      candidateId: 'cand-uuid-1',
      projectId: 'proj-uuid-1',
      matchResult: mockMatchResult,
      createdBy: 'テストユーザー',
    })

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        data_env: 'prod',
        candidate_id: 'cand-uuid-1',
        project_id: 'proj-uuid-1',
        match_score: 85,
      }),
      { onConflict: 'candidate_id,project_id' },
    )
    expect(result.match_score).toBe(85)
    expect(result.status).toBe('pending')
  })

  it('同一ペア(candidate_id, project_id)は上書き保存される', async () => {
    const updated = { ...mockSubmission, match_score: 90 }
    mockSingle.mockResolvedValueOnce({ data: updated, error: null })

    const { upsertSubmission } = await import('../submissions')
    const result = await upsertSubmission({
      candidateId: 'cand-uuid-1',
      projectId: 'proj-uuid-1',
      matchResult: { ...mockMatchResult, score: 90 },
      createdBy: 'テストユーザー',
    })

    expect(result.match_score).toBe(90)
  })

  it('Supabase がエラーを返したとき例外をスローする', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })

    const { upsertSubmission } = await import('../submissions')
    await expect(
      upsertSubmission({
        candidateId: 'x',
        projectId: 'y',
        matchResult: mockMatchResult,
        createdBy: 'user',
      }),
    ).rejects.toThrow('提案履歴の保存に失敗しました')
  })
})
