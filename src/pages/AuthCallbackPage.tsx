import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

type Status = 'loading' | 'success' | 'error'

const ACCOUNT_LABELS: Record<string, string> = {
  human_prod: '人材用（本番）',
  project_prod: '案件用（本番）',
  human_dev: '人材用（デモ）',
  project_dev: '案件用（デモ）',
}

export function AuthCallbackPage() {
  const [status, setStatus] = useState<Status>('loading')
  const [account, setAccount] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') ?? ''

    if (!code) {
      setStatus('error')
      setErrorMessage('認証コードが取得できませんでした。Microsoft のログインページでエラーが発生した可能性があります。')
      return
    }

    setAccount(state)

    const redirectUri = window.location.origin + '/auth/callback'

    supabase.functions
      .invoke('microsoft-oauth', {
        body: { step: 'callback', code, account: state, redirect_uri: redirectUri },
      })
      .then(({ data, error }) => {
        if (error) {
          setStatus('error')
          setErrorMessage(error.message ?? '不明なエラーが発生しました')
          return
        }
        if (!data?.ok) {
          setStatus('error')
          setErrorMessage(data?.error ?? '不明なエラーが発生しました')
          return
        }
        setStatus('success')
      })
      .catch((err: unknown) => {
        setStatus('error')
        setErrorMessage(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const accountLabel = ACCOUNT_LABELS[account] ?? account

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-blue-600 text-white px-4 py-3 shadow">
        <h1 className="text-lg font-bold tracking-tight">AkiNavi HR-AI</h1>
      </header>

      {/* Card */}
      <main className="flex items-center justify-center min-h-[calc(100vh-56px)] px-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 w-full max-w-md text-center">
          {status === 'loading' && (
            <>
              <Loader2 size={40} className="animate-spin text-blue-500 mx-auto mb-4" />
              <h2 className="text-base font-semibold text-gray-800 mb-2">連携処理中...</h2>
              <p className="text-sm text-gray-500">Microsoft アカウントとの連携を設定しています。しばらくお待ちください。</p>
            </>
          )}

          {status === 'success' && (
            <>
              <div className="text-4xl mb-4">✅</div>
              <h2 className="text-base font-semibold text-gray-800 mb-2">連携が完了しました</h2>
              <p className="text-sm text-gray-600 mb-6">
                {accountLabel ? `${accountLabel} の連携が完了しました。` : '連携が完了しました。'}
                <br />
                設定ページに戻ってご確認ください。
              </p>
              <a
                href="/"
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                設定ページに戻る
              </a>
            </>
          )}

          {status === 'error' && (
            <>
              <div className="text-4xl mb-4">❌</div>
              <h2 className="text-base font-semibold text-gray-800 mb-2">連携に失敗しました</h2>
              <p className="text-sm text-red-600 mb-6 break-all">{errorMessage}</p>
              <div className="flex flex-col gap-3">
                <a
                  href="/"
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  設定ページに戻る
                </a>
                <button
                  type="button"
                  onClick={() => window.history.back()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  前のページに戻る
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
