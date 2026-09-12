/**
 * チャンク読み込み失敗時の自動再読み込みの判定。
 *
 * 2026-09-12 に営業から
 * 「Failed to fetch dynamically imported module: .../HeatmapPage-C4K-0e0V.js」。
 * デプロイのたびに起きるので自動で1回リロードする。
 * ただし**回線が死んでいるときに無限リロードさせない**のが肝なので、そこを固定する。
 */
import { describe, it, expect } from 'vitest'
import { isChunkLoadError, shouldAutoReload, RELOAD_COOLDOWN_MS } from '../lazyPage'

describe('isChunkLoadError', () => {
  it('実際に報告された文言を拾う', () => {
    expect(isChunkLoadError(new TypeError(
      'Failed to fetch dynamically imported module: https://example.vercel.app/assets/HeatmapPage-C4K-0e0V.js',
    ))).toBe(true)
  })

  it('ブラウザごとの言い回しも拾う', () => {
    // Safari
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    // Firefox
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    // webpack 系（将来ビルダーを変えたとき用）
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true)
  })

  it('関係ないエラーでリロードしない', () => {
    expect(isChunkLoadError(new Error('候補者の取得に失敗しました'))).toBe(false)
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false)
  })

  it('Error でない値でも落ちない', () => {
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(true)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('shouldAutoReload', () => {
  it('まだ一度もリロードしていなければやる', () => {
    expect(shouldAutoReload(null, 1_000_000)).toBe(true)
  })

  it('直前にリロードしていたらやらない（無限ループを止める）', () => {
    const now = 1_000_000
    expect(shouldAutoReload(now - 1, now)).toBe(false)
    expect(shouldAutoReload(now - RELOAD_COOLDOWN_MS, now)).toBe(false)
  })

  it('クールダウンを過ぎていればまたやる（次のデプロイでも直せる）', () => {
    const now = 1_000_000
    expect(shouldAutoReload(now - RELOAD_COOLDOWN_MS - 1, now)).toBe(true)
  })
})
