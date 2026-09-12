/**
 * 元メール本文の表示。
 *
 * 人材一覧の詳細ペインにしか実体が無く、人材マップ・マッチング・案件詳細から
 * 開いた人材詳細では出ていなかった（2026-09-12 営業から指摘）。
 * 同じ人を見ているのに入った経路で表示が変わらないよう、1つの部品に寄せた。
 * ここが両方から使われていることを固定する。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OriginalEmailDetails } from '../OriginalEmailDetails'
import type { Candidate } from '../../lib/db/candidates'

function candidateWith(raw: Record<string, unknown> | null): Candidate {
  return { id: 'x', raw_profile: raw } as unknown as Candidate
}

describe('OriginalEmailDetails', () => {
  it('本文があれば件名・差出人と一緒に出す', () => {
    render(
      <OriginalEmailDetails
        candidate={candidateWith({
          text: 'お世話になっております。単価70万でご相談です。',
          subject: '【ご提案】Javaエンジニア',
          from: 'sales@example.co.jp',
        })}
      />,
    )
    expect(screen.getByText('元メール本文')).toBeTruthy()
    expect(screen.getByText(/単価70万でご相談です/)).toBeTruthy()
    expect(screen.getByText(/【ご提案】Javaエンジニア/)).toBeTruthy()
    expect(screen.getByText(/sales@example\.co\.jp/)).toBeTruthy()
  })

  it('本文が無ければ何も出さない（空の折りたたみを置かない）', () => {
    const { container } = render(<OriginalEmailDetails candidate={candidateWith({ text: '' })} />)
    expect(container.innerHTML).toBe('')
  })

  it('空白だけの本文も「無し」として扱う', () => {
    const { container } = render(<OriginalEmailDetails candidate={candidateWith({ text: '  \n ' })} />)
    expect(container.innerHTML).toBe('')
  })

  it('raw_profile が無くても落ちない', () => {
    const { container } = render(<OriginalEmailDetails candidate={candidateWith(null)} />)
    expect(container.innerHTML).toBe('')
  })

  it('件名・差出人が無くても本文だけ出す', () => {
    render(<OriginalEmailDetails candidate={candidateWith({ text: '本文だけ' })} />)
    expect(screen.getByText('本文だけ')).toBeTruthy()
    expect(screen.queryByText(/件名:/)).toBeNull()
    expect(screen.queryByText(/差出人:/)).toBeNull()
  })
})

describe('どの経路の人材詳細からも読めること', () => {
  // 実装を消されると気づけないので、呼び出し側に残っているかをソースで見る
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8')

  it('人材一覧の詳細ペインが使っている', () => {
    expect(read('pages/CandidatePage.tsx')).toContain('<OriginalEmailDetails')
  })

  it('人材詳細画面（人材マップ・マッチング・案件詳細からの遷移先）が使っている', () => {
    expect(read('pages/CandidateDetailPage.tsx')).toContain('<OriginalEmailDetails')
  })
})
