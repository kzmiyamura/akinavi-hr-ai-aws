/**
 * 画面を青一色（＝何も描かれていない）にしないための境界。
 *
 * 2026-10-20 営業から「人材マップから人材を選ぶと青くなる時がある」。
 * 人材詳細・案件詳細だけ境界の外にあり、遅延読み込みの失敗が**ルートまで抜けて
 * アプリ全体が外れていた**。しかも error_logs には何も残っていなかった
 * （直近の記録は 2026-06-23・実測）ので、再発しても原因が分からない状態だった。
 *
 * ここで固定するのは3つ: ①落ちても文字が出る ②逃げ道がある ③記録が残る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppErrorBoundary, __resetErrorLogDedupe } from '../AppErrorBoundary'

vi.mock('../../lib/errorLog', () => ({ logError: vi.fn(), saveErrorLog: vi.fn() }))
import { logError } from '../../lib/errorLog'

function Boom({ message }: { message: string }): React.ReactElement {
  throw new Error(message)
}

beforeEach(() => {
  __resetErrorLogDedupe()
  vi.mocked(logError).mockClear()
  // React は境界で捕まえた例外も console.error に出す（テスト出力を汚さない）
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('描画が落ちたとき', () => {
  it('何も描かれない状態にしない（必ず文言と再読み込みを出す）', () => {
    render(
      <AppErrorBoundary label="人材詳細">
        <Boom message="Cannot read properties of null" />
      </AppErrorBoundary>,
    )
    expect(screen.getByText('ページの読み込みに失敗しました')).toBeTruthy()
    expect(screen.getByText(/Cannot read properties of null/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeTruthy()
  })

  it('チャンクの取得失敗は「更新か通信」と書く（不具合と混ぜない）', () => {
    render(
      <AppErrorBoundary label="人材詳細">
        <Boom message="Failed to fetch dynamically imported module: /assets/CandidateDetailPage-abc.js" />
      </AppErrorBoundary>,
    )
    expect(screen.getByText(/アプリが更新されたか、通信が切れています/)).toBeTruthy()
    expect(vi.mocked(logError).mock.calls[0][2]).toMatchObject({ chunkLoad: true })
  })

  it('不具合は「他の画面は使える」と書く（固まったと思わせない）', () => {
    render(
      <AppErrorBoundary label="マッチング">
        <Boom message="x.map is not a function" />
      </AppErrorBoundary>,
    )
    expect(screen.getByText(/他の画面は使えます/)).toBeTruthy()
    expect(vi.mocked(logError).mock.calls[0][2]).toMatchObject({ chunkLoad: false })
  })

  it('error_logs に残す（境界が無かったので記録も無かった）', () => {
    render(
      <AppErrorBoundary label="人材詳細" dataEnv="prod" nickname="宮村">
        <Boom message="boom" />
      </AppErrorBoundary>,
    )
    expect(logError).toHaveBeenCalledTimes(1)
    const [err, page, context, opts] = vi.mocked(logError).mock.calls[0]
    expect((err as Error).message).toBe('boom')
    expect(page).toBe('人材詳細')
    expect(context).toMatchObject({ url: window.location.href, online: navigator.onLine })
    expect(opts).toMatchObject({ dataEnv: 'prod', nickname: '宮村' })
  })

  it('同じ所の同じ失敗で error_logs を埋めない', () => {
    render(<AppErrorBoundary label="人材詳細"><Boom message="同じ失敗" /></AppErrorBoundary>)
    render(<AppErrorBoundary label="人材詳細"><Boom message="同じ失敗" /></AppErrorBoundary>)
    expect(logError).toHaveBeenCalledTimes(1)
    // 別の枠・別の文面なら残す
    render(<AppErrorBoundary label="案件詳細"><Boom message="同じ失敗" /></AppErrorBoundary>)
    expect(logError).toHaveBeenCalledTimes(2)
  })

  it('通信が切れていても押せる逃げ道を先に出す（詳細画面）', () => {
    const onLeave = vi.fn()
    render(
      <AppErrorBoundary label="人材詳細" onLeave={onLeave}>
        <Boom message="boom" />
      </AppErrorBoundary>,
    )
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons[0]).toBe('一覧に戻る')
    fireEvent.click(screen.getByRole('button', { name: '一覧に戻る' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('別の人材を開き直したらエラー表示を解除する（resetKey）', () => {
    const { rerender } = render(
      <AppErrorBoundary label="人材詳細" resetKey="a"><Boom message="boom" /></AppErrorBoundary>,
    )
    expect(screen.getByText('ページの読み込みに失敗しました')).toBeTruthy()
    rerender(
      <AppErrorBoundary label="人材詳細" resetKey="b"><p>別の人材</p></AppErrorBoundary>,
    )
    expect(screen.getByText('別の人材')).toBeTruthy()
    expect(screen.queryByText('ページの読み込みに失敗しました')).toBeNull()
  })

  it('落ちていなければ素通し', () => {
    render(<AppErrorBoundary label="タブ"><p>中身</p></AppErrorBoundary>)
    expect(screen.getByText('中身')).toBeTruthy()
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('境界の外に残っている画面が無いこと', () => {
  const APP = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8')

  it('人材詳細・案件詳細が境界の中にある（ここが外れていたのが原因）', () => {
    for (const kind of ['candidate', 'project']) {
      const start = APP.indexOf(`{detail?.kind === '${kind}' && (`)
      expect(start, `detail?.kind === '${kind}' のブロックが無い`).toBeGreaterThan(-1)
      const block = APP.slice(start, start + 1200)
      // Suspense より先に境界が来ていること（境界の中に Suspense がある）
      expect(block.indexOf('<AppErrorBoundary'), `${kind} が境界の外にある`).toBeGreaterThan(-1)
      expect(block.indexOf('<AppErrorBoundary')).toBeLessThan(block.indexOf('<Suspense'))
      // 詳細は再読み込みせずに戻れること
      expect(block).toContain('onLeave=')
    }
  })

  it('ルートに最後の受け皿がある（何が落ちても青一色にしない）', () => {
    expect(APP).toContain('<AppErrorBoundary label="アプリ全体">')
  })
})
