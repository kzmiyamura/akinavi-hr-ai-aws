import { describe, it, expect, vi, beforeEach } from 'vitest'

// マッチング画面（人材モード）の左ペインはサーバー検索＋ページング。
// ここが壊れると全件（1,521件・5.25MB）を引く形に戻る、あるいは
// キーワードがサーバーに渡らず検索が効かなくなる。

const mockRpc = vi.fn()

vi.mock('../../supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}))

const { searchCandidatesForMatching, countCandidatesForMatching } = await import('../candidates')

describe('searchCandidatesForMatching', () => {
  beforeEach(() => mockRpc.mockReset())

  it('キーワード・モード・limit・offset をそのまま渡す', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: 'c1' }], error: null })

    await searchCandidatesForMatching('prod', ['java', 'aws'], 'OR', 50, 100)

    expect(mockRpc).toHaveBeenCalledWith('search_candidates_for_matching', {
      p_data_env: 'prod',
      p_keywords: ['java', 'aws'],
      p_mode: 'OR',
      p_limit: 50,
      p_offset: 100,
      // ★のみの絞り込み。既定は false（全人材）。50件ずつしか引かないので
      // 手元では絞れず、サーバー側に渡す必要がある（2026-08-31）
      p_bookmarked_only: false,
    })
  })

  it('★のみ指定を SQL 側に渡す', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })
    await searchCandidatesForMatching('prod', [], 'AND', 50, 0, true)
    expect(mockRpc).toHaveBeenCalledWith('search_candidates_for_matching',
      expect.objectContaining({ p_bookmarked_only: true }))
  })

  it('キーワードが空なら null を渡す（SQL側の「絞り込みなし」分岐に乗せる）', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    await searchCandidatesForMatching('prod', [], 'AND', 50)

    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_keywords: null, p_offset: 0 })
  })

  it('エラーは投げる（黙って空一覧にしない）', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(searchCandidatesForMatching('prod', [], 'AND', 50)).rejects.toThrow('boom')
  })
})

describe('countCandidatesForMatching', () => {
  beforeEach(() => mockRpc.mockReset())

  it('件数だけを数値で返す', async () => {
    mockRpc.mockResolvedValue({ data: 1521, error: null })

    await expect(countCandidatesForMatching('prod')).resolves.toBe(1521)
    expect(mockRpc).toHaveBeenCalledWith('count_candidates_for_matching', {
      p_data_env: 'prod',
      p_keywords: null,
      p_mode: 'AND',
    })
  })

  it('文字列で返ってきても数値にする（bigint は JSON で文字列になりうる）', async () => {
    mockRpc.mockResolvedValue({ data: '1521', error: null })

    await expect(countCandidatesForMatching('prod')).resolves.toBe(1521)
  })

  it('検索語があれば件数側にも渡す（「全N件」と一覧がズレないように）', async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null })

    await countCandidatesForMatching('prod', ['java'], 'OR')

    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_keywords: ['java'], p_mode: 'OR' })
  })
})
