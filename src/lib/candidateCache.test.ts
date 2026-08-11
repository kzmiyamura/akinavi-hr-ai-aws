import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { patchCandidateInCache, removeCandidateFromCache } from './candidateCache'
import type { Candidate } from './db/candidates'

/**
 * キャッシュの部分更新は「一覧の再取得をやめる」ための最適化なので、
 * 誤ると画面の表示が実データとズレたまま気づけない。
 * ページ構造を保つこと・対象以外を触らないことを固定する。
 */
const cand = (id: string, over: Partial<Candidate> = {}) =>
  ({ id, name: `名前${id}`, box_status: 'pending', ...over }) as Candidate

const seed = (qc: QueryClient) => {
  qc.setQueryData(['candidates-paged', 'prod'], {
    pageParams: [0, 100],
    pages: [
      { candidates: [cand('a'), cand('b')], totalCount: 5 },
      { candidates: [cand('c')], totalCount: null },
    ],
  })
}
const read = (qc: QueryClient) =>
  qc.getQueryData(['candidates-paged', 'prod']) as {
    pageParams: number[]
    pages: { candidates: Candidate[]; totalCount: number | null }[]
  }

describe('patchCandidateInCache', () => {
  it('対象の1人だけを更新する', () => {
    const qc = new QueryClient()
    seed(qc)
    patchCandidateInCache(qc, 'prod', 'b', { box_status: 'fetch_requested' })
    const d = read(qc)
    expect(d.pages[0].candidates[1].box_status).toBe('fetch_requested')
    expect(d.pages[0].candidates[0].box_status).toBe('pending')   // 他は触らない
    expect(d.pages[1].candidates[0].box_status).toBe('pending')
  })

  it('後続ページの人材も更新できる', () => {
    const qc = new QueryClient()
    seed(qc)
    patchCandidateInCache(qc, 'prod', 'c', { box_status: 'enriched' })
    expect(read(qc).pages[1].candidates[0].box_status).toBe('enriched')
  })

  it('ページ構造と pageParams を壊さない', () => {
    const qc = new QueryClient()
    seed(qc)
    patchCandidateInCache(qc, 'prod', 'a', { box_status: 'fetching' })
    const d = read(qc)
    expect(d.pages).toHaveLength(2)
    expect(d.pageParams).toEqual([0, 100])
    expect(d.pages[0].totalCount).toBe(5)
  })

  it('該当が無ければ何も変えない', () => {
    const qc = new QueryClient()
    seed(qc)
    patchCandidateInCache(qc, 'prod', 'zzz', { box_status: 'failed' })
    const d = read(qc)
    expect(d.pages[0].candidates.map(c => c.box_status)).toEqual(['pending', 'pending'])
  })

  it('キャッシュが無くても落ちない', () => {
    const qc = new QueryClient()
    expect(() => patchCandidateInCache(qc, 'prod', 'a', { box_status: 'x' })).not.toThrow()
  })
})

describe('removeCandidateFromCache', () => {
  it('対象を取り除き、総件数を1減らす', () => {
    const qc = new QueryClient()
    seed(qc)
    removeCandidateFromCache(qc, 'prod', 'a')
    const d = read(qc)
    expect(d.pages[0].candidates.map(c => c.id)).toEqual(['b'])
    expect(d.pages[0].totalCount).toBe(4)
  })

  it('totalCount が null のページは触らない', () => {
    const qc = new QueryClient()
    seed(qc)
    removeCandidateFromCache(qc, 'prod', 'c')
    const d = read(qc)
    expect(d.pages[1].candidates).toHaveLength(0)
    expect(d.pages[1].totalCount).toBeNull()
  })

  it('総件数が負にならない', () => {
    const qc = new QueryClient()
    qc.setQueryData(['candidates-paged', 'prod'], {
      pageParams: [0], pages: [{ candidates: [cand('a')], totalCount: 0 }],
    })
    removeCandidateFromCache(qc, 'prod', 'a')
    expect(read(qc).pages[0].totalCount).toBe(0)
  })
})
