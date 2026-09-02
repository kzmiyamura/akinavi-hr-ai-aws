import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CommercialFlowBadge, commercialFlowClass } from '../CommercialFlowBadge'

describe('commercialFlowClass', () => {
  it('自社は緑（直接紹介できる）', () => {
    expect(commercialFlowClass('自社')).toContain('emerald')
  })

  it('1社先は黄（1社挟む）', () => {
    expect(commercialFlowClass('1社先')).toContain('amber')
  })

  it('2社先以上は赤（深いので警戒）', () => {
    expect(commercialFlowClass('2社先')).toContain('red')
    expect(commercialFlowClass('3社先')).toContain('red')
  })

  it('数字が読めない表記は黄に倒す（赤で驚かせない）', () => {
    expect(commercialFlowClass('不明')).toContain('amber')
  })
})

describe('CommercialFlowBadge', () => {
  it('商流が無ければ何も出さない', () => {
    const { container } = render(<CommercialFlowBadge flow={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('空白だけなら何も出さない', () => {
    const { container } = render(<CommercialFlowBadge flow="   " />)
    expect(container).toBeEmptyDOMElement()
  })

  it('商流をそのまま表示する', () => {
    render(<CommercialFlowBadge flow="1社先" />)
    expect(screen.getByText('1社先')).toBeInTheDocument()
  })

  it('マッチングカードでは小さいフォントにする', () => {
    render(<CommercialFlowBadge flow="自社" size="xs" />)
    expect(screen.getByText('自社').className).toContain('text-[10px]')
  })

  it('人材詳細では通常フォント', () => {
    render(<CommercialFlowBadge flow="自社" />)
    expect(screen.getByText('自社').className).toContain('text-xs')
  })

  it('意味が分かるよう説明を持たせる', () => {
    render(<CommercialFlowBadge flow="2社先" />)
    expect(screen.getByText('2社先')).toHaveAttribute('title', expect.stringContaining('商流位置'))
  })
})
