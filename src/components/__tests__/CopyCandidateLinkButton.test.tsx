/**
 * 「URLをコピー」ボタン（2026-10-20 営業の要望
 * 「アプリで一発で開ける url をクリップボードにコピーできるボタン。人材詳細の全部の箇所に」）。
 *
 * 一番怖い壊れ方は2つ:
 *   ① コピーした URL で開けない（形が通知メールのリンクとズレる）
 *   ② 押したのに何も起きない（`navigator.clipboard` が無い端末で黙って終わる）
 * どちらも画面を見ているだけでは気づけないので、ここで固定する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CopyCandidateLinkButton } from '../CopyCandidateLinkButton'

const ID = '3f1b7c6e-8a2d-4e5f-9b01-2c3d4e5f6a7b'

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

beforeEach(() => {
  // jsdom には execCommand が無い（呼ぶと TypeError）。旧 API の分岐も明示的に試験する
  Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('人材を直接開く URL のコピー', () => {
  it('通知メールのリンクと同じ形（origin + /?c=<uuid>）をコピーする', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<CopyCandidateLinkButton candidateId={ID} dataEnv="prod" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toBe(`${window.location.origin}/?c=${ID}`)
  })

  it('URL に入るのは uuid だけ（氏名・メール・人材番号を貼り先に残さない）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<CopyCandidateLinkButton candidateId={ID} dataEnv="prod" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const url = new URL(writeText.mock.calls[0][0] as string)
    expect([...url.searchParams.keys()]).toEqual(['c'])
    expect(url.searchParams.get('c')).toBe(ID)
  })

  it('コピーできたら画面に出す（押せたか分からないボタンにしない）', async () => {
    stubClipboard(() => Promise.resolve())
    render(<CopyCandidateLinkButton candidateId={ID} dataEnv="prod" />)
    expect(screen.getByRole('button').textContent).toContain('URLをコピー')
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('コピーしました'))
  })

  it('コピーできなかったら URL を画面に出す（黙って成功に見せない）', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')))
    render(<CopyCandidateLinkButton candidateId={ID} dataEnv="prod" />)
    fireEvent.click(screen.getByRole('button'))
    const input = await screen.findByLabelText(/手でコピー/) as HTMLInputElement
    expect(input.value).toBe(`${window.location.origin}/?c=${ID}`)
    expect(input.readOnly).toBe(true)
    // 「コピーしました」とは言わない
    expect(screen.getByRole('button').textContent).toContain('URLをコピー')
  })

  it('clipboard API が無い端末でも旧 API を試す（https でない社内 IP 対策）', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    render(<CopyCandidateLinkButton candidateId={ID} dataEnv="prod" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('コピーしました'))
  })

  it('デモの人材は「デモ端末でしか開けない」と説明に書く', () => {
    stubClipboard(() => Promise.resolve())
    const { rerender } = render(<CopyCandidateLinkButton candidateId={ID} dataEnv="demo" />)
    expect(screen.getByRole('button').title).toContain('デモ表示を解除していない端末では開けません')
    // 本番は7日で消えることを書く（開けない理由がリンク切れだと分からない）
    rerender(<CopyCandidateLinkButton candidateId={ID} dataEnv="prod" />)
    expect(screen.getByRole('button').title).toContain('7日で消えます')
  })
})

describe('人材詳細の全部の箇所に置いてあること', () => {
  // 画面が3つあり、置き忘れても他の画面では動くので気づけない。呼び出し側をソースで見る
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8')

  it('人材詳細画面（人材マップ・マッチング結果・案件詳細・重複からの遷移先）', () => {
    expect(read('pages/CandidateDetailPage.tsx')).toContain('<CopyCandidateLinkButton')
  })

  it('人材タブの詳細ペイン', () => {
    expect(read('pages/CandidatePage.tsx')).toContain('<CopyCandidateLinkButton')
  })

  it('マッチングの人材ペイン', () => {
    expect(read('pages/MatchingPage.tsx')).toContain('<CopyCandidateLinkButton')
  })

  it('URL の組み立ては通知メールと同じ関数（形が2か所に分かれるとリンクがズレる）', () => {
    expect(read('components/CopyCandidateLinkButton.tsx')).toContain('candidateLinkUrl(window.location.origin')
  })
})
