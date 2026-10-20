import { afterEach, describe, it, expect, vi } from 'vitest'
import { captureScroll, runScrollRestore, scrollToRestore, NO_SCROLL } from '../listScrollMemory'

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

/**
 * 2026-10-20 営業の指摘「人材マップで人材を開いた後、戻るとスクロールが消えてる」。
 * 人材タブには同じ復元が入っていたが、人材マップ（App 側の詳細）には無かった。
 * 書き写しを避けて runScrollRestore に切り出したので、ここで挙動を固定する。
 */
describe('runScrollRestore', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => {
    cleanup?.()
    cleanup = null
    vi.restoreAllMocks()
  })

  /** window.scrollY を可変にする（jsdom は読み取り専用） */
  function fakeWindowScroll(onScroll: (top: number) => number) {
    let y = 0
    Object.defineProperty(window, 'scrollY', { get: () => y, configurable: true })
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(((arg: unknown) => {
      const top = typeof arg === 'number' ? arg : (arg as ScrollToOptions).top ?? 0
      y = onScroll(top)
    }) as typeof window.scrollTo)
    return spy
  }

  const nextFrames = (ms = 80) => new Promise((r) => setTimeout(r, ms))

  it('1フレームで届かなくても追いかける（戻った直後は一覧の高さが足りない）', async () => {
    let calls = 0
    // 1回目は高さが足りず切り詰められる＝届かない。2回目以降は届く
    const spy = fakeWindowScroll((top) => (++calls === 1 ? 200 : top))
    cleanup = runScrollRestore({ container: 0, window: 1180 })
    await nextFrames()
    expect(spy.mock.calls.length).toBeGreaterThan(1)
    expect(window.scrollY).toBe(1180)
  })

  it('指で動かされたらやめる（競うと「スクロールが効かない」体感になる）', async () => {
    const spy = fakeWindowScroll(() => 200) // いつまでも届かない
    cleanup = runScrollRestore({ container: 0, window: 1180 })
    await nextFrames(32)
    window.dispatchEvent(new Event('touchstart'))
    const after = spy.mock.calls.length
    await nextFrames()
    expect(spy.mock.calls.length).toBe(after)
  })

  it('一覧コンテナ（PC）の位置も戻す', async () => {
    fakeWindowScroll((top) => top)
    const box = { scrollTop: 0 } as HTMLElement
    cleanup = runScrollRestore({ container: 320, window: 0 }, () => box)
    await nextFrames()
    expect(box.scrollTop).toBe(320)
  })

  it('後片付けを呼べば追いかけるのをやめる', async () => {
    const spy = fakeWindowScroll(() => 200)
    const stop = runScrollRestore({ container: 0, window: 1180 })
    await nextFrames(32)
    stop()
    const after = spy.mock.calls.length
    await nextFrames()
    expect(spy.mock.calls.length).toBe(after)
  })
})
