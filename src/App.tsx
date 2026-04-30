import { useEffect, useState } from 'react'
import { checkConnection } from './lib/checkConnection'

type Status = 'checking' | 'ok' | 'error'

function App() {
  const [status, setStatus] = useState<Status>('checking')
  const [configs, setConfigs] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    checkConnection().then((result) => {
      if (result.ok) {
        setStatus('ok')
        setConfigs(result.tables)
      } else {
        setStatus('error')
        setErrorMsg(result.error ?? '不明なエラー')
      }
    })
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow p-8 w-full max-w-md text-center space-y-4">
        <h1 className="text-2xl font-bold text-gray-800">AkiNavi HR-AI</h1>
        <p className="text-sm text-gray-500">Supabase 接続確認</p>

        {status === 'checking' && (
          <p className="text-blue-500 animate-pulse">接続確認中...</p>
        )}

        {status === 'ok' && (
          <div className="space-y-2">
            <p className="text-green-600 font-semibold">接続成功</p>
            <p className="text-sm text-gray-600">
              app_config に登録済みのキー:
            </p>
            <ul className="text-sm text-gray-700 space-y-1">
              {configs.map((k) => (
                <li key={k} className="bg-green-50 rounded px-3 py-1">{k}</li>
              ))}
            </ul>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-2">
            <p className="text-red-600 font-semibold">接続失敗</p>
            <p className="text-xs text-red-400 break-all">{errorMsg}</p>
            <p className="text-sm text-gray-500">
              Supabase で schema.sql を実行しているか確認してください。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
