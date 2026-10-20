import { describe, expect, it } from 'vitest'
import { MARK_LABEL, markButton, nextStatusFor, type MarkKind } from '../submissionAction'
import type { Submission } from '../db/submissions'

/**
 * #191「提案済にする画面がどこからも開けない」の修正（2026-10-20）。
 * 印の遷移をここで固定する。画面側（MatchingPage）はこの判定を呼ぶだけにする。
 */
const ALL: Submission['status'][] = ['pending', 'sent', 'accepted', 'rejected']

describe('提案の印', () => {
  it('pending から押せば、その印になる', () => {
    expect(nextStatusFor('pending', 'sent')).toBe('sent')
    expect(nextStatusFor('pending', 'rejected')).toBe('rejected')
  })

  it('同じ印をもう一度押したら pending に戻る（押し間違いを自分で直せる）', () => {
    expect(nextStatusFor('sent', 'sent')).toBe('pending')
    expect(nextStatusFor('rejected', 'rejected')).toBe('pending')
  })

  it('別の印を押せば乗り換える', () => {
    expect(nextStatusFor('sent', 'rejected')).toBe('rejected')
    expect(nextStatusFor('rejected', 'sent')).toBe('sent')
  })

  it('参画確定の行は印で動かさない（決定を先に取り消す）', () => {
    for (const kind of ['sent', 'rejected'] as MarkKind[]) {
      expect(nextStatusFor('accepted', kind)).toBeNull()
      expect(markButton('accepted', kind).disabled).toBe(true)
      expect(markButton('accepted', kind).title).toContain('決定を取り消して')
    }
  })

  it('押せる状態なら必ず遷移先がある（どの状態でも固まらない）', () => {
    for (const st of ALL) {
      for (const kind of ['sent', 'rejected'] as MarkKind[]) {
        const b = markButton(st, kind)
        expect(b.disabled).toBe(nextStatusFor(st, kind) === null)
        expect(b.label).toContain(MARK_LABEL[kind])
      }
    }
  })

  it('印が付いている方は「✓」で分かる', () => {
    expect(markButton('sent', 'sent').active).toBe(true)
    expect(markButton('sent', 'sent').label).toBe('提案済 ✓')
    expect(markButton('pending', 'sent').label).toBe('提案済にする')
    expect(markButton('pending', 'sent').active).toBe(false)
  })

  it('説明文に、押すと人材一覧の印になることを書く', () => {
    expect(markButton('pending', 'sent').title).toContain('人材一覧')
    expect(markButton('pending', 'rejected').title).toContain('人材一覧')
  })
})
