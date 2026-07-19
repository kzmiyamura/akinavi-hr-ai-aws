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
    // useNickname は cookie 優先保存（PWA対策 55375fb）のため cookie も消す
    document.cookie = 'akinavi_nickname=; max-age=0; path=/'
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
    document.cookie = 'akinavi_nickname=; max-age=0; path=/'
    localStorage.setItem('akinavi_nickname', 'テストユーザー')
  })

  it('初回表示はマッチング結果である', async () => {
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('マッチング結果一覧')).toBeInTheDocument()
    })
  })

  it('人材タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByRole('button', { name: '人材' }))
    fireEvent.click(screen.getByRole('button', { name: '人材' }))
    // CandidatePage は lazy ロードのため待つ（「新規登録」ボタンは一覧に常時表示）
    await waitFor(() => expect(screen.getByText('新規登録')).toBeInTheDocument())
  })

  it('案件タブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByRole('button', { name: '案件' }))
    fireEvent.click(screen.getByRole('button', { name: '案件' }))
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/案件名・必須\/尚可スキル/)).toBeInTheDocument())
  })

  it('マッチングタブに切り替えられる', async () => {
    renderApp()
    await waitFor(() => screen.getByRole('button', { name: '案件' }))
    fireEvent.click(screen.getByRole('button', { name: '案件' }))
    await waitFor(() => screen.getByPlaceholderText(/案件名・必須\/尚可スキル/))
    fireEvent.click(screen.getByRole('button', { name: 'マッチング' }))
    expect(screen.getByText('マッチング結果一覧')).toBeInTheDocument()
  })
})
