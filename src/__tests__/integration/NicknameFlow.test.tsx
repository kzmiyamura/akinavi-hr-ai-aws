import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../App'

// Supabase・AI をモック
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) })) })),
      upsert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null, error: null }) })) })),
    })),
  },
}))

vi.mock('../../lib/ai', () => ({
  ai: {
    analyzeCandidate: vi.fn(),
    analyzeProject: vi.fn(),
    matchCandidateToProject: vi.fn(),
  },
}))

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><App /></QueryClientProvider>)
}

describe('ニックネームフロー', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('初回アクセス時にニックネーム入力モーダルが表示される', () => {
    renderApp()
    expect(screen.getByText('あなたの名前を入力してください')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例: 田中 / Tanaka')).toBeInTheDocument()
  })

  it('ニックネームを入力してはじめるを押すとメイン画面に遷移する', async () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / Tanaka')
    fireEvent.change(input, { target: { value: '田中' } })
    fireEvent.click(screen.getByText('使いはじめる'))

    await waitFor(() => {
      expect(screen.getByText('マッチング結果一覧')).toBeInTheDocument()
    })
  })

  it('空のニックネームではエラーメッセージが表示される', () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / Tanaka')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByText('使いはじめる'))
    expect(screen.getByText('ニックネームを入力してください')).toBeInTheDocument()
  })

  it('21文字以上のニックネームではエラーメッセージが表示される', () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / Tanaka')
    fireEvent.change(input, { target: { value: 'a'.repeat(21) } })
    fireEvent.click(screen.getByText('使いはじめる'))
    expect(screen.getByText('20文字以内で入力してください')).toBeInTheDocument()
  })

  it('ニックネームが localStorage に保存される', async () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / Tanaka')
    fireEvent.change(input, { target: { value: '鈴木' } })
    fireEvent.click(screen.getByText('使いはじめる'))

    await waitFor(() => {
      expect(localStorage.getItem('akinavi_nickname')).toBe('鈴木')
    })
  })

  it('localStorage にニックネームがある場合、モーダルをスキップしてメイン画面を表示する', async () => {
    localStorage.setItem('akinavi_nickname', '既存ユーザー')
    renderApp()

    await waitFor(() => {
      expect(screen.getByText('マッチング結果一覧')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('例: 田中 / tanaka')).not.toBeInTheDocument()
    })
  })
})

describe('タブナビゲーション', () => {
  beforeEach(() => {
    localStorage.setItem('akinavi_nickname', 'テストユーザー')
  })

  it('初回表示はマッチング結果である', async () => {
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('マッチング結果一覧')).toBeInTheDocument()
    })
  })

  it('人材登録タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('人材登録'))
    fireEvent.click(screen.getByText('人材登録'))
    expect(screen.getByText('人材を登録')).toBeInTheDocument()
  })

  it('案件登録タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('案件登録'))
    fireEvent.click(screen.getByText('案件登録'))
    expect(screen.getByText('案件を登録')).toBeInTheDocument()
  })

  it('マッチング結果タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('人材登録'))
    fireEvent.click(screen.getByText('案件登録'))
    await waitFor(() => screen.getByText('案件を登録'))
    fireEvent.click(screen.getByText('マッチング結果'))
    expect(screen.getByText('マッチング結果一覧')).toBeInTheDocument()
  })
})
