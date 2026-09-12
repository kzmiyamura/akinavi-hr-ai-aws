/**
 * タブのページを遅延読み込みする lazy()。**チャンクが消えていたら自動で1回だけ再読み込みする。**
 *
 * 2026-09-12 に営業から
 * 「Failed to fetch dynamically imported module: .../HeatmapPage-C4K-0e0V.js」
 * の報告。デプロイするとチャンク名のハッシュが変わり、**開いたままのタブが持っている
 * 古いモジュールグラフ**が消えたファイルを指す。ビルドのたびに必ず起こる性質のもので、
 * ユーザー側に落ち度は無い。
 *
 * 再読み込みすれば新しい index.html を取り直して直るので、エラー画面を出す前に
 * こちらで1回やる。ただし**回線が死んでいるときに無限リロードしない**よう、
 * 直前に1回やっていたら諦めてエラーを投げ、TabErrorBoundary に任せる。
 */
import { lazy } from 'react'
import type { ComponentType } from 'react'

const RELOAD_KEY = 'akinavi.chunkReloadAt'
/** この時間内に既に自動リロードしていたら、もうやらない（無限ループ防止） */
export const RELOAD_COOLDOWN_MS = 10_000

/**
 * 自動リロードしてよいか。
 * 「前回いつ自動リロードしたか」だけで決める。クールダウンを過ぎていれば、
 * 次のデプロイでまた同じことが起きたときにちゃんと直せる。
 */
export function shouldAutoReload(lastReloadAt: number | null, now: number): boolean {
  if (lastReloadAt === null) return true
  return now - lastReloadAt > RELOAD_COOLDOWN_MS
}

function readLastReloadAt(): number | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function markReloaded(now: number): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    /* ignore（プライベートブラウズ。リロードはするが記録が残らないだけ） */
  }
}

/** 動的 import の失敗か（ブラウザごとに文言が違うので広めに見る） */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|error loading dynamically imported module/i.test(msg)
}

// React 本体の lazy と同じ型にする。ここを狭めるとページごとの props が通らない
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    load().catch((err: unknown) => {
      const now = Date.now()
      if (!isChunkLoadError(err) || !shouldAutoReload(readLastReloadAt(), now)) throw err
      markReloaded(now)
      window.location.reload()
      // リロードが走るまで解決しない。Suspense の «読み込み中» のままにして、
      // 一瞬エラー画面を見せない
      return new Promise<{ default: T }>(() => {})
    }),
  )
}
