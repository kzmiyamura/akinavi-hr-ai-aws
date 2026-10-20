/**
 * 一覧 → 詳細 → 一覧 と往復したときのスクロール位置の記憶（#80 の作り直し・2026-09-05）。
 *
 * 直した2点:
 *  ① スマホは一覧の div に高さ制約が無く（`md:max-h-[640px]` は md 以上だけ）、
 *     スクロールしているのは**ウィンドウそのもの**。div の scrollTop は常に 0 なので、
 *     div だけ覚える実装は保存値 0 で素通りしていた。両方覚えて両方戻す。
 *  ② 詳細から別の人材へ飛ぶとき（「同一人材の可能性」）に覚え直すと、
 *     一覧へ戻ったとき詳細側の位置に飛ぶ。**開いている間は上書きしない**。
 */

export interface ScrollMemory {
  /** 一覧コンテナの scrollTop（PC） */
  container: number
  /** ウィンドウの scrollY（スマホ） */
  window: number
}

export const NO_SCROLL: ScrollMemory = { container: 0, window: 0 }

/**
 * 人材を開くときに覚える位置を決める。
 * すでに詳細が開いているなら覚え直さない（詳細→詳細の移動）。
 */
export function captureScroll(
  isDetailOpen: boolean,
  saved: ScrollMemory,
  current: ScrollMemory,
): ScrollMemory {
  return isDetailOpen ? saved : current
}

/**
 * 一覧に戻ったときに復元すべき位置。どちらも 0 なら何もしない
 * （復元処理が余計なスクロールを起こさないため）。
 */
export function scrollToRestore(saved: ScrollMemory): ScrollMemory | null {
  if (saved.container === 0 && saved.window === 0) return null
  return saved
}

/**
 * 保存位置へ**届くまで追いかける**。戻り値は後片付けなので useEffect からそのまま返す。
 *
 * ⚠ 1〜2フレームでは届かない。詳細を開いている間、一覧は `hidden` で高さを持たないので、
 *    戻した直後の `documentElement.scrollHeight` が保存位置より小さく、
 *    切り詰められた位置で止まる（2026-09-05 の実害）。
 * ⚠ 追いかけている最中にユーザーが指で動かしたら即やめる。競うと
 *    「スクロールが効かない」体感になる（同日の実害）。
 *
 * 2026-10-20 に CandidatePage から切り出した。人材マップ（App 側の詳細）でも
 * 同じことが起きていた＝「戻るとスクロールが消えてる」。2か所で書き写すとまたズレる。
 */
export function runScrollRestore(
  target: ScrollMemory,
  getContainer: () => HTMLElement | null = () => null,
  deadlineMs = 700,
): () => void {
  let raf = 0
  let stopped = false
  const deadline = performance.now() + deadlineMs
  const stop = () => { stopped = true }
  const events = ['touchstart', 'wheel', 'keydown'] as const
  events.forEach((e) => window.addEventListener(e, stop, { passive: true, once: true }))

  const reached = () => {
    const winOk = target.window === 0 || Math.abs(window.scrollY - target.window) <= 2
    const el = getContainer()
    const boxOk = target.container === 0 || !el || Math.abs(el.scrollTop - target.container) <= 2
    return winOk && boxOk
  }
  const tick = () => {
    if (stopped) return
    const el = getContainer()
    if (el && target.container > 0) el.scrollTop = target.container
    if (target.window > 0) window.scrollTo({ top: target.window })
    if (!reached() && performance.now() < deadline) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(raf)
    events.forEach((e) => window.removeEventListener(e, stop))
  }
}
