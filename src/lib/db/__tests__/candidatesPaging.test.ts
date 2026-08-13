import { describe, it, expect, vi, beforeEach } from 'vitest'

// PostgREST は1リクエスト1000行で頭打ちになる（db-max-rows）。
// p_limit をいくら大きくしても効かないので、呼び出し側が p_offset で回して集める。
// ここが壊れると人材が黙って一覧から消える（2026-08-14 に 1,521人中 521人が欠けていた）。

const mockRpc = vi.fn()

vi.mock('../../supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}))

const { fetchCandidatesForMatching, findDuplicateCandidatesBatch } = await import('../candidates')

/** id だけ持つダミー行を n 件作る */
const rows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${offset + i}` }))

describe('fetchCandidatesForMatching', () => {
  beforeEach(() => mockRpc.mockReset())

  it('1000件で切られても p_offset で続きを取りに行く', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: rows(1000, 0), error: null })
      .mockResolvedValueOnce({ data: rows(521, 1000), error: null })

    const result = await fetchCandidatesForMatching('prod', 2000)

    expect(result).toHaveLength(1521)
    expect(new Set(result.map((c) => c.id)).size).toBe(1521)
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_offset: 0, p_limit: 1000 })
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_offset: 1000, p_limit: 1000 })
  })

  it('1ページ目が満杯でなければ2ページ目を引かない', async () => {
    mockRpc.mockResolvedValueOnce({ data: rows(300), error: null })

    const result = await fetchCandidatesForMatching('prod', 2000)

    expect(result).toHaveLength(300)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('limit を超えて取りに行かない', async () => {
    mockRpc.mockResolvedValue({ data: rows(1000), error: null })

    await fetchCandidatesForMatching('prod', 1000)

    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('エラーはそのまま投げる（黙って空を返さない）', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })

    await expect(fetchCandidatesForMatching('prod')).rejects.toThrow('boom')
  })
})

describe('findDuplicateCandidatesBatch', () => {
  beforeEach(() => mockRpc.mockReset())

  it('source_id ごとに束ねて返す', async () => {
    mockRpc.mockReturnValue({
      range: () =>
        Promise.resolve({
          data: [
            { source_id: 'a', id: 'x', name: 'X', skills: ['Java'], raw_profile: { prefecture: '東京都' } },
            { source_id: 'a', id: 'y', name: 'Y', skills: [], raw_profile: {} },
            { source_id: 'b', id: 'z', name: 'Z', skills: null, raw_profile: null },
          ],
          error: null,
        }),
    })

    const map = await findDuplicateCandidatesBatch(['a', 'b'], 'prod')

    expect(Object.keys(map).sort()).toEqual(['a', 'b'])
    expect(map.a.map((d) => d.id)).toEqual(['x', 'y'])
    expect(map.b[0].id).toBe('z')
    // null は落とさず既定値に寄せる（画面側で ?? を書かなくて済むように）
    expect(map.b[0].skills).toEqual([])
    expect(map.b[0].raw_profile).toEqual({})
  })

  it('空配列なら問い合わせない', async () => {
    const map = await findDuplicateCandidatesBatch([], 'prod')
    expect(map).toEqual({})
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('エラー時は空を返す（重複表示が出ないだけで画面は壊さない）', async () => {
    mockRpc.mockReturnValue({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) })

    const map = await findDuplicateCandidatesBatch(['a'], 'prod')

    expect(map).toEqual({})
  })
})
