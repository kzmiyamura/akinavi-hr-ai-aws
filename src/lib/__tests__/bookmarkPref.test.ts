/**
 * 「★のみ表示」の端末別設定。
 * 星そのものはチーム共有（DB）だが、絞り込むかどうかは見る人の都合なので端末に持つ。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readBookmarkOnly, writeBookmarkOnly } from '../bookmarkPref'

describe('bookmarkPref', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('未設定なら false（全人材を表示）', () => {
    expect(readBookmarkOnly('candidates')).toBe(false)
    expect(readBookmarkOnly('matching')).toBe(false)
  })

  it('保存した値を読み戻せる', () => {
    writeBookmarkOnly('candidates', true)
    expect(readBookmarkOnly('candidates')).toBe(true)
  })

  it('人材タブとマッチングタブは独立している', () => {
    writeBookmarkOnly('candidates', true)
    expect(readBookmarkOnly('matching')).toBe(false)
    writeBookmarkOnly('matching', true)
    writeBookmarkOnly('candidates', false)
    expect(readBookmarkOnly('matching')).toBe(true)
    expect(readBookmarkOnly('candidates')).toBe(false)
  })

  it('壊れた値が入っていても既定に倒れる', () => {
    localStorage.setItem('akinavi.bookmarkOnly.v1', '{壊れたJSON')
    expect(readBookmarkOnly('candidates')).toBe(false)
  })

  it('localStorage が使えなくても例外を投げない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeBookmarkOnly('candidates', true)).not.toThrow()
    expect(readBookmarkOnly('candidates')).toBe(false)
  })
})
