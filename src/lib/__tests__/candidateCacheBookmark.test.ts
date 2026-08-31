/**
 * ブックマークを押したとき、どの画面のキャッシュも一度に書き換わることを確かめる。
 *
 * 星は一覧・詳細・マッチング・人材マップのどこからでも押せる。押した場所以外を
 * 更新しないと、タブを切り替えたときに古い状態が見える。かといって invalidate すると
 * 一覧の再取得（約100KB/ページ）が走るので、キャッシュだけを差し替える。
 */
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { patchCandidateEverywhere } from '../candidateCache'
import type { Candidate } from '../db/candidates'

const cand = (id: string, bookmarked = false): Candidate => ({
  id, data_env: 'prod', name: `名前${id}`, email: null, phone: null,
  skills: ['Java'], experience_years: 5, raw_profile: {}, duplicate_flag: false,
  bookmarked, merged_into: null, created_by: 'x', updated_by: null,
  created_at: '2026-08-31T00:00:00Z', updated_at: '2026-08-31T00:00:00Z',
  resume_url: null, drive_url: null, box_url: null, box_status: null,
  desired_rate: null, from_company: null,
})

describe('patchCandidateEverywhere', () => {
  it('無限スクロールの一覧を更新する', () => {
    const qc = new QueryClient()
    qc.setQueryData(['candidates-paged', 'prod'], {
      pages: [{ candidates: [cand('a'), cand('b')] }, { candidates: [cand('c')] }],
    })
    patchCandidateEverywhere(qc, 'b', { bookmarked: true })
    const data = qc.getQueryData(['candidates-paged', 'prod']) as { pages: { candidates: Candidate[] }[] }
    expect(data.pages[0].candidates.find((c) => c.id === 'b')?.bookmarked).toBe(true)
    expect(data.pages[0].candidates.find((c) => c.id === 'a')?.bookmarked).toBe(false)
  })

  it('人材の配列（マッチング画面）を更新する', () => {
    const qc = new QueryClient()
    qc.setQueryData(['candidates-page', 'prod'], [cand('a'), cand('b')])
    patchCandidateEverywhere(qc, 'a', { bookmarked: true })
    const list = qc.getQueryData(['candidates-page', 'prod']) as Candidate[]
    expect(list[0].bookmarked).toBe(true)
    expect(list[1].bookmarked).toBe(false)
  })

  it('1件だけのキャッシュ（詳細画面）を更新する', () => {
    const qc = new QueryClient()
    qc.setQueryData(['candidates', 'prod', 'a'], cand('a'))
    patchCandidateEverywhere(qc, 'a', { bookmarked: true })
    expect((qc.getQueryData(['candidates', 'prod', 'a']) as Candidate).bookmarked).toBe(true)
  })

  it('複数の画面のキャッシュを同時に更新する', () => {
    const qc = new QueryClient()
    qc.setQueryData(['candidates-paged', 'prod'], { pages: [{ candidates: [cand('a')] }] })
    qc.setQueryData(['candidates-page', 'prod'], [cand('a')])
    qc.setQueryData(['candidates', 'prod', 'a'], cand('a'))
    patchCandidateEverywhere(qc, 'a', { bookmarked: true })
    const paged = qc.getQueryData(['candidates-paged', 'prod']) as { pages: { candidates: Candidate[] }[] }
    expect(paged.pages[0].candidates[0].bookmarked).toBe(true)
    expect((qc.getQueryData(['candidates-page', 'prod']) as Candidate[])[0].bookmarked).toBe(true)
    expect((qc.getQueryData(['candidates', 'prod', 'a']) as Candidate).bookmarked).toBe(true)
  })

  it('人材以外のキャッシュ（案件・提案履歴）は壊さない', () => {
    const qc = new QueryClient()
    const projects = [{ id: 'a', title: '案件', status: 'open' }]
    const stats = { total: 10, byId: { a: 3 } }
    qc.setQueryData(['projects', 'prod'], projects)
    qc.setQueryData(['submission-stats', 'prod'], stats)
    patchCandidateEverywhere(qc, 'a', { bookmarked: true })
    expect(qc.getQueryData(['projects', 'prod'])).toEqual(projects)
    expect(qc.getQueryData(['submission-stats', 'prod'])).toEqual(stats)
  })

  it('該当しない id なら何も変えない', () => {
    const qc = new QueryClient()
    const before = { pages: [{ candidates: [cand('a')] }] }
    qc.setQueryData(['candidates-paged', 'prod'], before)
    patchCandidateEverywhere(qc, 'zzz', { bookmarked: true })
    expect(qc.getQueryData(['candidates-paged', 'prod'])).toBe(before)
  })
})
