import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Loader2 } from 'lucide-react'
import { fetchCandidateById } from '../lib/db/candidates'
import { CandidateProfileFields, CandidateEditModal } from './CandidatePage'

interface Props {
  candidateId: string
  nickname: string
  onBack: () => void
}

export function CandidateDetailPage({ candidateId, nickname, onBack }: Props) {
  const queryClient = useQueryClient()
  const [editingOpen, setEditingOpen] = useState(false)

  const { data: candidate, isLoading, error, isError } = useQuery({
    queryKey: ['candidates', candidateId],
    queryFn: () => fetchCandidateById(candidateId),
  })

  function handleSaved() {
    queryClient.invalidateQueries({ queryKey: ['candidates', candidateId] })
    queryClient.invalidateQueries({ queryKey: ['candidates'] })
    setEditingOpen(false)
  }

  return (
    <div className="space-y-6">
      {candidate && editingOpen && (
        <CandidateEditModal
          candidate={candidate}
          nickname={nickname}
          onClose={() => setEditingOpen(false)}
          onSaved={handleSaved}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-2 bg-white hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
          戻る
        </button>
        {candidate && (
          <button
            type="button"
            onClick={() => setEditingOpen(true)}
            className="inline-flex items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <Pencil size={15} />
            編集
          </button>
        )}
      </div>

      {isLoading && (
        <p className="text-sm text-gray-400 flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" />
          読み込み中...
        </p>
      )}
      {isError && (
        <p className="text-sm text-red-600">{error instanceof Error ? error.message : String(error)}</p>
      )}
      {!isLoading && !isError && !candidate && (
        <p className="text-sm text-gray-500">人材が見つかりません（削除された可能性があります）。</p>
      )}
      {candidate && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <CandidateProfileFields c={candidate} isExpanded={false} detailMode />
        </div>
      )}
    </div>
  )
}
