import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Loader2, ExternalLink, Reply } from 'lucide-react'
import { fetchCandidateById, type Candidate } from '../lib/db/candidates'
import { patchCandidateInCache } from '../lib/candidateCache'
import { CandidateProfileFields, CandidateEditModal } from './CandidatePage'
import { toViewerUrl } from '../lib/viewerUrl'
import type { DataEnv } from '../lib/dataEnv'

interface Props {
  candidateId: string
  nickname: string
  dataEnv: DataEnv
  onBack: () => void
}

export function CandidateDetailPage({ candidateId, nickname, dataEnv, onBack }: Props) {
  const queryClient = useQueryClient()
  const [editingOpen, setEditingOpen] = useState(false)

  const { data: candidate, isLoading, error, isError } = useQuery({
    queryKey: ['candidates', dataEnv, candidateId],
    queryFn: () => fetchCandidateById(candidateId, dataEnv),
  })

  function handleSaved(patch: Partial<Candidate>) {
    // 編集値は手元にあるので、このページの詳細行と人材タブの一覧は部分更新で反映する
    // （invalidate だと詳細行35KB＋一覧全ページの再取得が飛ぶ）
    queryClient.setQueryData(['candidates', dataEnv, candidateId], (old: unknown) =>
      old ? { ...(old as Candidate), ...patch } : old)
    patchCandidateInCache(queryClient, dataEnv, candidateId, patch)
    if (patch.raw_profile) {
      queryClient.setQueryData(['candidate-raw-profile', candidateId], patch.raw_profile)
    }
    // マッチング/履歴/重複タブの全件クエリは従来どおり stale 化（非表示中は再取得は飛ばない）
    queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv], exact: true })
    setEditingOpen(false)
  }

  return (
    <div className="space-y-6">
      {candidate && editingOpen && (
        <CandidateEditModal
          candidate={candidate}
          nickname={nickname}
          dataEnv={dataEnv}
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
        {candidate && (() => {
          const rp = candidate.raw_profile as Record<string, unknown>
          const rawText = rp?.text as string | null
          const from = rp?.from as string | null
          const subject = rp?.subject as string | null
          const receivedAt = rp?.emailReceivedAt as string | null
          const resumeLink = candidate.drive_url || candidate.resume_url || (() => {
            const m = (rawText ?? '').match(/https:\/\/drive\.google\.com\/[^\s"'<>\]）]+/)
            return m ? m[0] : null
          })()
          return (
            <>
              {resumeLink && (
                <a
                  href={toViewerUrl(resumeLink)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm border border-blue-200 rounded-lg px-4 py-2 text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  <ExternalLink size={15} />
                  経歴書
                </a>
              )}
              {from && (() => {
                const reSubject = encodeURIComponent(`Re: ${subject ?? ''}`)
                const quoted = encodeURIComponent([
                  '', '',
                  '--- 元のメッセージ ---',
                  `差出人: ${from}`,
                  `件名: ${subject ?? ''}`,
                  receivedAt ? `日時: ${new Date(receivedAt).toLocaleString('ja-JP')}` : '',
                  '',
                  (rawText ?? '').slice(0, 800),
                  (rawText ?? '').length > 800 ? '\n...[以下省略]' : '',
                ].join('\n'))
                return (
                  <a
                    href={`mailto:${from}?subject=${reSubject}&body=${quoted}`}
                    className="inline-flex items-center gap-2 text-sm border border-gray-200 rounded-lg px-4 py-2 text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                    title="返信（元メール引用）"
                  >
                    <Reply size={15} />
                    返信
                  </a>
                )
              })()}
            </>
          )
        })()}
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
        <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 min-w-0">
          <CandidateProfileFields c={candidate} isExpanded={false} detailMode />
        </div>
      )}
    </div>
  )
}
