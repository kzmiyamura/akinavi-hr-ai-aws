import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AnalyzeCandidateResponse } from '../../ai/types'

// Supabase クライアントをモック
const mockSingle = vi.fn()
const mockSelect = vi.fn(() => ({ single: mockSingle }))
const mockUpsert = vi.fn(() => ({ select: mockSelect }))
const mockInsert = vi.fn(() => ({ select: mockSelect }))
const mockEq    = vi.fn()
const mockIs    = vi.fn()
const mockOrder = vi.fn()

vi.mock('../../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      upsert: mockUpsert,
      insert: mockInsert,
      select: vi.fn(() => ({
        is: mockIs,
        eq: mockEq,
        order: mockOrder,
      })),
    })),
  },
}))

const baseAnalyzed: AnalyzeCandidateResponse = {
  name: '山田 太郎',
  email: 'yamada@example.com',
  phone: '090-1234-5678',
  skills: ['Java', 'AWS'],
  experienceYears: 5,
  summary: 'バックエンドエンジニア',
}

const mockCandidate = {
  id: 'uuid-1',
  data_env: 'prod',
  name: '山田 太郎',
  email: 'yamada@example.com',
  phone: '090-1234-5678',
  skills: ['Java', 'AWS'],
  experience_years: 5,
  raw_profile: { text: '...', summary: 'バックエンドエンジニア' },
  duplicate_flag: false,
  merged_into: null,
  created_by: 'テストユーザー',
  created_at: '2026-04-30T00:00:00Z',
  updated_at: '2026-04-30T00:00:00Z',
}

describe('upsertCandidate', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSingle.mockReset()
    mockUpsert.mockReset()
    mockInsert.mockReset()
    mockUpsert.mockReturnValue({ select: mockSelect })
    mockInsert.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ single: mockSingle })
  })

  it('email あり: upsert を呼び出し、結果を返す', async () => {
    mockSingle.mockResolvedValueOnce({ data: mockCandidate, error: null })

    const { upsertCandidate } = await import('../candidates')
    const result = await upsertCandidate({
      analyzed: baseAnalyzed,
      rawText: '山田太郎のプロフィール',
      createdBy: 'テストユーザー',
    })

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'yamada@example.com', data_env: 'prod' }),
      { onConflict: 'email' },
    )
    expect(result.id).toBe('uuid-1')
    expect(result.name).toBe('山田 太郎')
  })

  it('email あり: 同一メールの既存レコードを上書き更新する（upsert の onConflict=email）', async () => {
    const updated = { ...mockCandidate, skills: ['Java', 'AWS', 'Kubernetes'] }
    mockSingle.mockResolvedValueOnce({ data: updated, error: null })

    const { upsertCandidate } = await import('../candidates')
    const result = await upsertCandidate({
      analyzed: { ...baseAnalyzed, skills: ['Java', 'AWS', 'Kubernetes'] },
      rawText: '更新されたプロフィール',
      createdBy: 'テストユーザー',
    })

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'yamada@example.com', data_env: 'prod' }),
      { onConflict: 'email' },
    )
    expect(result.skills).toContain('Kubernetes')
  })

  it('email なし: insert を呼び出す', async () => {
    const noEmail = { ...mockCandidate, email: null }
    mockSingle.mockResolvedValueOnce({ data: noEmail, error: null })

    const { upsertCandidate } = await import('../candidates')
    await upsertCandidate({
      analyzed: { ...baseAnalyzed, email: null },
      rawText: 'メールなしプロフィール',
      createdBy: 'テストユーザー',
    })

    expect(mockInsert).toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('duplicateSuspected=true のとき duplicate_flag=true で保存される', async () => {
    const flagged = { ...mockCandidate, duplicate_flag: true }
    mockSingle.mockResolvedValueOnce({ data: flagged, error: null })

    const { upsertCandidate } = await import('../candidates')
    const result = await upsertCandidate({
      analyzed: baseAnalyzed,
      rawText: 'テスト',
      createdBy: 'テストユーザー',
      duplicateSuspected: true,
    })

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate_flag: true }),
      expect.anything(),
    )
    expect(result.duplicate_flag).toBe(true)
  })

  it('Supabase がエラーを返したとき例外をスローする', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })

    const { upsertCandidate } = await import('../candidates')
    await expect(
      upsertCandidate({ analyzed: baseAnalyzed, rawText: 'test', createdBy: 'user' }),
    ).rejects.toThrow('候補者の保存に失敗しました')
  })
})
