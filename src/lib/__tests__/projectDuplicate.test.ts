import { describe, it, expect } from 'vitest'
import { normalizeProjectText, findDuplicateProjectByText } from '../projectDuplicate'

const p = (id: string, title: string, text: unknown) =>
  ({ id, title, created_at: '2026-09-08T06:19:22Z', raw_data: { text } })

describe('normalizeProjectText', () => {
  it('空白の違いを吸収する', () => {
    expect(normalizeProjectText('大手銀行　海外店\r\n与信管理'))
      .toBe(normalizeProjectText('大手銀行 海外店\n与信管理'))
  })

  it('ゼロ幅文字を無視する', () => {
    expect(normalizeProjectText('与​信管理')).toBe('与信管理')
  })

  it('保存側と同じ10,000文字で切る', () => {
    expect(normalizeProjectText('あ'.repeat(12000))).toHaveLength(10000)
  })

  it('null / undefined は空文字', () => {
    expect(normalizeProjectText(null)).toBe('')
    expect(normalizeProjectText(undefined)).toBe('')
  })
})

describe('findDuplicateProjectByText', () => {
  const body = '大手銀行海外店の与信管理システムのヘルプデスク。Java/SQL。月80万。'

  it('同じ本文の案件を見つける（タイトルが違っても）', () => {
    // prod 実データの形: 同一本文なのに抽出タイトルが「１．」の有無で割れた
    const list = [
      p('a', '大手銀行海外店の与信管理システムのヘルプ', body),
      p('b', '別案件', 'まったく違う本文'),
    ]
    const hit = findDuplicateProjectByText(list, body)
    expect(hit?.id).toBe('a')
  })

  it('空白違いでも同一と見なす', () => {
    const list = [p('a', 'x', '大手銀行　海外店\r\nの与信')]
    expect(findDuplicateProjectByText(list, '大手銀行 海外店 の与信')?.id).toBe('a')
  })

  it('違う本文なら見つけない', () => {
    const list = [p('a', 'x', body)]
    expect(findDuplicateProjectByText(list, '別の案件の説明文です')).toBeNull()
  })

  it('空文字どうしを一致にしない', () => {
    const list = [p('a', 'x', ''), p('b', 'y', '   ')]
    expect(findDuplicateProjectByText(list, '')).toBeNull()
    expect(findDuplicateProjectByText(list, '   ')).toBeNull()
  })

  it('raw_data や text が無い案件を飛ばす', () => {
    const list = [
      { id: 'a', title: 'x' },
      { id: 'b', title: 'y', raw_data: null },
      { id: 'c', title: 'z', raw_data: { text: 123 } },
      p('d', 'w', body),
    ]
    expect(findDuplicateProjectByText(list, body)?.id).toBe('d')
  })

  it('空リストなら null', () => {
    expect(findDuplicateProjectByText([], body)).toBeNull()
  })
})
