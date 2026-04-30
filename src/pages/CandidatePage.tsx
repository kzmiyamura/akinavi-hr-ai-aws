import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, UserPlus, RefreshCw } from 'lucide-react'
import { ai } from '../lib/ai'
import { upsertCandidate, fetchCandidates } from '../lib/db/candidates'
import type { Candidate } from '../lib/db/candidates'

interface Props { nickname: string }

export function CandidatePage({ nickname }: Props) {
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const queryClient = useQueryClient()

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ['candidates'],
    queryFn: fetchCandidates,
  })

  const mutation = useMutation({
    mutationFn: async (rawText: string) => {
      const analyzed = await ai.analyzeCandidate({ rawText })
      // 既存候補と名前・スキルの類似チェックは AI のマッチング判定に委ねる
      // ここでは単純に duplicateSuspected=false で登録（Phase 3 の重複管理で対応）
      return upsertCandidate({ analyzed, rawText, createdBy: nickname })
    },
    onSuccess: (candidate) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setText('')
      const msg = candidate.duplicate_flag
        ? `登録完了（重複の疑いフラグあり）: ${candidate.name}`
        : `登録完了: ${candidate.name}`
      setMessage({ type: 'success', text: msg })
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
    },
  })

  return (
    <div className="space-y-6">
      {/* 入力フォーム */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
          <UserPlus size={18} className="text-blue-600" />
          人材を登録
        </h2>
        <p className="text-sm text-gray-500">
          メール本文・職務経歴書・スキルシートなどのテキストを貼り付けてください。
          AI が自動解析して登録します。同じメールアドレスの場合は上書き更新されます。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="テキストをここに貼り付け..."
          rows={8}
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </p>
        )}
        <button
          onClick={() => { setMessage(null); mutation.mutate(text) }}
          disabled={!text.trim() || mutation.isPending}
          className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
          {mutation.isPending ? 'AI解析中...' : '解析して登録'}
        </button>
      </div>

      {/* 候補者一覧 */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <RefreshCw size={18} className="text-gray-500" />
          登録済み人材（{candidates.length}件）
        </h2>
        {isLoading ? (
          <p className="text-sm text-gray-400">読み込み中...</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-gray-400">まだ登録されていません</p>
        ) : (
          <div className="space-y-3">
            {candidates.map((c: Candidate) => (
              <div key={c.id} className="border border-gray-100 rounded-lg p-4 flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800 text-sm">{c.name}</span>
                    {c.duplicate_flag && (
                      <span className="text-xs bg-yellow-100 text-yellow-700 rounded px-2 py-0.5">重複の疑い</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {c.email ?? 'メールなし'} ／ 経験{c.experience_years ?? '?'}年
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(c.skills as string[]).slice(0, 6).map((s) => (
                      <span key={s} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{s}</span>
                    ))}
                    {(c.skills as string[]).length > 6 && (
                      <span className="text-xs text-gray-400">+{(c.skills as string[]).length - 6}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-gray-300 whitespace-nowrap ml-4">{c.created_by}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
