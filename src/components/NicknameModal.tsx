import { useState } from 'react'

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
        <h1 className="text-2xl font-bold text-gray-800 mb-1">AkiNavi HR-AI</h1>
        <p className="text-sm text-gray-500 mb-6">
          はじめに、あなたのニックネームを設定してください。
          <br />
          登録データの作成者として記録されます。
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError('') }}
              placeholder="例: 田中 / tanaka"
              className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
          </div>
          <button
            type="submit"
            className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            はじめる
          </button>
        </form>
      </div>
    </div>
  )
}
