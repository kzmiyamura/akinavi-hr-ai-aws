import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { History, CheckCircle, XCircle, Send } from 'lucide-react'
import { fetchAllProjects } from '../lib/db/projects'
import { fetchCandidates } from '../lib/db/candidates'
import { fetchSubmissionsByProject } from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import { useState } from 'react'
import type { Project } from '../lib/db/projects'
import type { Candidate } from '../lib/db/candidates'
import type { Submission } from '../lib/db/submissions'

export function HistoryPage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const queryClient = useQueryClient()

  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: fetchAllProjects })
  const { data: candidates = [] } = useQuery({ queryKey: ['candidates'], queryFn: fetchCandidates })
  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ['submissions', selectedProjectId],
    queryFn: () => fetchSubmissionsByProject(selectedProjectId),
    enabled: !!selectedProjectId,
  })

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Submission['status'] }) => {
      const { error } = await supabase.from('submissions').update({ status }).eq('id', id)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['submissions', selectedProjectId] }),
  })

  const statusLabel: Record<Submission['status'], string> = {
    pending:  '未送信',
    sent:     '送信済み',
    accepted: '採用',
    rejected: '不採用',
  }
  const statusColor: Record<Submission['status'], string> = {
    pending:  'bg-gray-100 text-gray-600',
    sent:     'bg-blue-100 text-blue-700',
    accepted: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-500',
  }

  const getCandidateName = (id: string) =>
    (candidates as Candidate[]).find((c) => c.id === id)?.name ?? '不明'

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
          <History size={18} className="text-blue-600" />
          提案履歴
        </h2>

        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">案件を選択...</option>
          {(projects as Project[]).map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      {selectedProjectId && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          {isLoading ? (
            <p className="text-sm text-gray-400">読み込み中...</p>
          ) : (submissions as Submission[]).length === 0 ? (
            <p className="text-sm text-gray-400">この案件の提案履歴はありません</p>
          ) : (
            <div className="space-y-3">
              {(submissions as Submission[]).map((s) => (
                <div key={s.id} className="border border-gray-100 rounded-lg p-4 flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-800">{getCandidateName(s.candidate_id)}</span>
                      <span className={`text-xs rounded px-2 py-0.5 ${statusColor[s.status]}`}>
                        {statusLabel[s.status]}
                      </span>
                      <span className="text-sm font-bold text-gray-600">Score: {s.match_score}</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{s.ai_summary}</p>
                  </div>

                  {/* ステータス操作ボタン */}
                  <div className="flex gap-1 shrink-0">
                    {s.status === 'pending' && (
                      <button
                        onClick={() => statusMutation.mutate({ id: s.id, status: 'sent' })}
                        className="flex items-center gap-1 text-xs bg-blue-50 text-blue-700 rounded px-2 py-1 hover:bg-blue-100"
                      >
                        <Send size={12} />送信済みにする
                      </button>
                    )}
                    {s.status === 'sent' && (
                      <>
                        <button
                          onClick={() => statusMutation.mutate({ id: s.id, status: 'accepted' })}
                          className="flex items-center gap-1 text-xs bg-green-50 text-green-700 rounded px-2 py-1 hover:bg-green-100"
                        >
                          <CheckCircle size={12} />採用
                        </button>
                        <button
                          onClick={() => statusMutation.mutate({ id: s.id, status: 'rejected' })}
                          className="flex items-center gap-1 text-xs bg-red-50 text-red-500 rounded px-2 py-1 hover:bg-red-100"
                        >
                          <XCircle size={12} />不採用
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
