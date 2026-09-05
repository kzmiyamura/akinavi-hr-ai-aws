import { describe, it, expect } from 'vitest'
import { captureScroll, scrollToRestore, NO_SCROLL } from '../listScrollMemory'

describe('captureScroll', () => {
  it('一覧から開くときは今の位置を覚える', () => {
    expect(captureScroll(false, NO_SCROLL, { container: 320, window: 0 }))
      .toEqual({ container: 320, window: 0 })
  })

  it('スマホ（ウィンドウが動く）でも覚える', () => {
    expect(captureScroll(false, NO_SCROLL, { container: 0, window: 1180 }))
      .toEqual({ container: 0, window: 1180 })
  })

  it('詳細から別の人材へ飛ぶときは覚え直さない', () => {
    const saved = { container: 320, window: 0 }
    // 詳細を開いている間のスクロール位置（詳細側の位置）で上書きしない
    expect(captureScroll(true, saved, { container: 0, window: 900 })).toEqual(saved)
  })
})

describe('scrollToRestore', () => {
  it('覚えた位置があれば返す', () => {
    expect(scrollToRestore({ container: 320, window: 0 })).toEqual({ container: 320, window: 0 })
    expect(scrollToRestore({ container: 0, window: 1180 })).toEqual({ container: 0, window: 1180 })
  })

  it('先頭に居たなら復元しない（余計なスクロールを起こさない）', () => {
    expect(scrollToRestore(NO_SCROLL)).toBeNull()
  })
})
