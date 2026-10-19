import { describe, expect, it } from 'vitest'
import {
  SUBMISSION_STATUS_LABEL,
  badgeStyle,
  hasHumanSubmission,
  resolveCandidateBadge,
  type BadgeTone,
} from '../submissionBadge'
import type { SubmissionBadge } from '../db/submissions'
import type { TopMatchMarkSet } from '../db/topMatchMarks'

/**
 * 2026-10-19 の2つの指摘を固定する:
 *  ①「提案候補の意味がわからない。何に対して？また4って何？」
 *    → pending を印にしない。案件名を出す。数字には単位を付ける。
 *  ②「マッチングやり直したら上位に入るかもの印が出たらいいかも」
 *    → 今の上位（top_match_marks）を「上位候補」として出す。
 *      人が動かした記録（決定・提案済・見送り）はそちらを優先する。
 */
const sub = (over: Partial<SubmissionBadge> = {}): SubmissionBadge => ({
  count: 1,
  best: 'pending',
  projects: [{ projectId: 'p1', title: '淀屋橋 販売管理', status: 'pending', at: '2026-10-12T00:00:00Z' }],
  ...over,
})

const marks = (over: Partial<TopMatchMarkSet> = {}): TopMatchMarkSet => ({
  count: 1,
  projects: [{ projectId: 'p9', title: '国際系勘定システム', rank: 3 }],
  ...over,
})

describe('人材一覧の印', () => {
  it('マッチング実行の副産物（pending）だけでは印を出さない', () => {
    expect(resolveCandidateBadge(sub(), null)).toBeNull()
    expect(resolveCandidateBadge(sub({ count: 4 }), undefined)).toBeNull()
    expect(hasHumanSubmission(sub())).toBe(false)
  })

  it('印が1つも無ければ null', () => {
    expect(resolveCandidateBadge(null, null)).toBeNull()
    expect(resolveCandidateBadge(undefined, { count: 0, projects: [] })).toBeNull()
  })

  it('上位候補は案件名と順位を出す', () => {
    const b = resolveCandidateBadge(sub(), marks())!
    expect(b.tone).toBe('topMatch')
    expect(b.text).toBe('上位候補: 国際系勘定システム（3位）')
    expect(b.shortText).toBe('上位候補 3位')
  })

  it('複数案件で上位なら件数に単位を付ける（裸の数字を出さない）', () => {
    const b = resolveCandidateBadge(null, marks({
      count: 3,
      projects: [
        { projectId: 'p9', title: '国際系勘定システム', rank: 3 },
        { projectId: 'p8', title: '化成品メーカー向け保守開発', rank: 1 },
      ],
    }))!
    // 順位の良い順に並べ替えてから先頭を出す
    expect(b.text).toBe('上位候補: 化成品メーカー向け保守開発（1位）他2案件')
    expect(b.shortText).toBe('上位候補 3案件')
    expect(b.shortText).not.toMatch(/\d$/)
  })

  it('人が動かした記録があればそちらを優先する', () => {
    for (const best of ['accepted', 'sent', 'rejected'] as const) {
      const b = resolveCandidateBadge(
        sub({ best, projects: [{ projectId: 'p1', title: '淀屋橋 販売管理', status: best, at: '2026-10-12T00:00:00Z' }] }),
        marks(),
      )!
      expect(b.tone).toBe(best)
      expect(b.text).toBe(`${SUBMISSION_STATUS_LABEL[best]}: 淀屋橋 販売管理`)
      expect(b.text).not.toContain('上位候補')
    }
  })

  it('決定した案件が履歴の先頭でなくても、決定した案件名を出す', () => {
    const b = resolveCandidateBadge(sub({
      count: 2,
      best: 'accepted',
      projects: [
        { projectId: 'p1', title: '淀屋橋 販売管理', status: 'pending', at: '2026-10-12T00:00:00Z' },
        { projectId: 'p2', title: '新宿 Java基盤', status: 'accepted', at: '2026-10-09T00:00:00Z' },
      ],
    }), null)!
    expect(b.text).toBe('決定: 新宿 Java基盤 他1案件')
  })

  it('「提案候補」という言葉を画面に出さない', () => {
    const all = [
      resolveCandidateBadge(null, marks())!,
      resolveCandidateBadge(sub({ best: 'sent' }), null)!,
    ]
    for (const b of all) {
      expect(b.text).not.toContain('提案候補')
      expect(b.shortText).not.toContain('提案候補')
    }
  })

  it('上位候補の補足に「1時間」の遅れを書く（新着が漏れることを隠さない）', () => {
    const b = resolveCandidateBadge(null, marks())!
    expect(b.title).toContain('1時間')
    expect(b.title).toContain('3位 国際系勘定システム')
  })

  it('印ごとに色が分かれる（枠線あり・なしの両方）', () => {
    const tones: BadgeTone[] = ['accepted', 'sent', 'rejected', 'topMatch']
    for (const bordered of [true, false]) {
      const seen = tones.map((t) => badgeStyle(t, bordered))
      expect(new Set(seen).size).toBe(tones.length)
      for (const cls of seen) expect(cls.includes('border-')).toBe(bordered)
    }
  })
})
