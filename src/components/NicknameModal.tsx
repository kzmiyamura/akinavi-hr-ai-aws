import { useState } from 'react'
import { UserCircle } from 'lucide-react'

interface Props {
  onSave: (nickname: string) => void
}

export function NicknameModal({ onSave }: Props) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      setError('ニックネームを入力してください')
      return
    }
    if (trimmed.length > 20) {
      setError('20文字以内で入力してください')
      return
    }
    onSave(trimmed)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm mx-4">
        <div className="flex flex-col items-center mb-6">
          <UserCircle size={48} className="text-blue-500 mb-3" />
          <h1 className="text-xl font-bold text-gray-800">あなたの名前を入力してください</h1>
          <p className="text-sm text-gray-500 mt-2 text-center">
            登録データに「誰が追加したか」を残すために使います。
          </p>
          <p className="text-xs text-gray-400 mt-1 text-center">
            このブラウザに保存されるため、次回から不要です。
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError('') }}
              placeholder="例: 田中 / Tanaka"
              className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
          </div>
          <button
            type="submit"
            className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            使いはじめる
          </button>
        </form>
      </div>
    </div>
  )
}
