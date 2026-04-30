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
    expect(screen.getByText('AkiNavi HR-AI')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例: 田中 / tanaka')).toBeInTheDocument()
  })

  it('ニックネームを入力してはじめるを押すとメイン画面に遷移する', async () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / tanaka')
    fireEvent.change(input, { target: { value: '田中' } })
    fireEvent.click(screen.getByText('はじめる'))

    await waitFor(() => {
      expect(screen.getByText('人材登録')).toBeInTheDocument()
    })
  })

  it('空のニックネームではエラーメッセージが表示される', () => {
    renderApp()
    fireEvent.click(screen.getByText('はじめる'))
    expect(screen.getByText('ニックネームを入力してください')).toBeInTheDocument()
  })

  it('21文字以上のニックネームではエラーメッセージが表示される', () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / tanaka')
    fireEvent.change(input, { target: { value: 'a'.repeat(21) } })
    fireEvent.click(screen.getByText('はじめる'))
    expect(screen.getByText('20文字以内で入力してください')).toBeInTheDocument()
  })

  it('ニックネームが localStorage に保存される', async () => {
    renderApp()
    const input = screen.getByPlaceholderText('例: 田中 / tanaka')
    fireEvent.change(input, { target: { value: '鈴木' } })
    fireEvent.click(screen.getByText('はじめる'))

    await waitFor(() => {
      expect(localStorage.getItem('akinavi_nickname')).toBe('鈴木')
    })
  })

  it('localStorage にニックネームがある場合、モーダルをスキップしてメイン画面を表示する', async () => {
    localStorage.setItem('akinavi_nickname', '既存ユーザー')
    renderApp()

    await waitFor(() => {
      expect(screen.getByText('人材登録')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('例: 田中 / tanaka')).not.toBeInTheDocument()
    })
  })
})

describe('タブナビゲーション', () => {
  beforeEach(() => {
    localStorage.setItem('akinavi_nickname', 'テストユーザー')
  })

  it('案件登録タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('案件登録'))
    fireEvent.click(screen.getByText('案件登録'))
    expect(screen.getByText('案件を登録')).toBeInTheDocument()
  })

  it('マッチングタブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('マッチング'))
    fireEvent.click(screen.getByText('マッチング'))
    expect(screen.getByText('マッチング実行')).toBeInTheDocument()
  })

  it('提案履歴タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('提案履歴'))
    fireEvent.click(screen.getByText('提案履歴'))
    expect(screen.getByText('案件を選択...')).toBeInTheDocument()
  })

  it('重複管理タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByText('重複管理'))
    fireEvent.click(screen.getByText('重複管理'))
    expect(screen.getByText(/重複の疑いがある人材/)).toBeInTheDocument()
  })
})
