import { describe, expect, it } from 'vitest'
import {
  SUBMISSION_STATUS_LABEL,
  submissionBadgeShortText,
  submissionBadgeStyle,
  submissionBadgeText,
  submissionBadgeTitle,
} from '../submissionBadge'
import type { SubmissionBadge } from '../db/submissions'

/**
 * 2026-10-19 の指摘「提案候補の意味がわからない。何に対して？また4って何？」。
 * 直した内容を固定する:
 *  ① pending を「提案候補」と書かない（人が提案した記録ではなく、マッチング実行の副産物）
 *  ② どの案件に対してかを出す
 *  ③ 数字に必ず単位を付ける（裸の「4」は順位にも人数にも読めた）
 */
const badge = (over: Partial<SubmissionBadge> = {}): SubmissionBadge => ({
  count: 1,
  best: 'pending',
  projects: [{ projectId: 'p1', title: '淀屋橋 販売管理', status: 'pending', at: '2026-10-12T00:00:00Z' }],
  ...over,
})

describe('提案バッジの文言', () => {
  it('pending を「提案候補」と書かない', () => {
    expect(SUBMISSION_STATUS_LABEL.pending).toBe('マッチ済')
    for (const label of Object.values(SUBMISSION_STATUS_LABEL)) {
      expect(label).not.toContain('提案候補')
    }
  })

  it('1案件なら案件名を出す', () => {
    expect(submissionBadgeText(badge())).toBe('マッチ済: 淀屋橋 販売管理')
  })

  it('複数案件なら件数に単位を付ける（裸の数字を出さない）', () => {
    const sb = badge({
      count: 4,
      projects: [
        { projectId: 'p1', title: '淀屋橋 販売管理', status: 'pending', at: '2026-10-12T00:00:00Z' },
        { projectId: 'p2', title: '新宿 Java基盤', status: 'pending', at: '2026-10-09T00:00:00Z' },
      ],
    })
    expect(submissionBadgeText(sb)).toBe('マッチ済: 淀屋橋 販売管理 他3案件')
    expect(submissionBadgeShortText(sb)).toBe('マッチ済 4案件')
    // 「4」だけで終わらない＝単位が付いている
    expect(submissionBadgeShortText(sb)).not.toMatch(/\d$/)
  })

  it('1案件なら狭い行では件数を出さない', () => {
    expect(submissionBadgeShortText(badge())).toBe('マッチ済')
  })

  it('一番進んでいる状態がラベルになる', () => {
    expect(submissionBadgeText(badge({ best: 'accepted' }))).toBe('決定: 淀屋橋 販売管理')
    expect(submissionBadgeText(badge({ best: 'sent' }))).toBe('提案済: 淀屋橋 販売管理')
    expect(submissionBadgeText(badge({ best: 'rejected' }))).toBe('見送り: 淀屋橋 販売管理')
  })

  it('案件が1件も取れなくても落ちない（件数だけ出す）', () => {
    expect(submissionBadgeText(badge({ count: 3, projects: [] }))).toBe('マッチ済 3案件')
    expect(submissionBadgeText(badge({ count: 1, projects: [] }))).toBe('マッチ済')
  })

  it('補足には案件名を全部並べる', () => {
    const sb = badge({
      count: 2,
      projects: [
        { projectId: 'p1', title: '淀屋橋 販売管理', status: 'pending', at: '2026-10-12T00:00:00Z' },
        { projectId: 'p2', title: '新宿 Java基盤', status: 'rejected', at: '2026-10-09T00:00:00Z' },
      ],
    })
    expect(submissionBadgeTitle(sb)).toBe(
      'マッチングの結果が 2案件ぶん残っています\n・淀屋橋 販売管理（マッチ済）\n・新宿 Java基盤（見送り）',
    )
  })

  it('状態ごとに色が分かれる（枠線あり・なしの両方）', () => {
    const states: SubmissionBadge['best'][] = ['accepted', 'sent', 'rejected', 'pending']
    for (const bordered of [true, false]) {
      const seen = states.map((best) => submissionBadgeStyle(badge({ best }), bordered))
      expect(new Set(seen).size).toBe(states.length)
      for (const cls of seen) expect(cls.includes('border-')).toBe(bordered)
    }
  })
})
