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
