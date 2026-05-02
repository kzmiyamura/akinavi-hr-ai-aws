import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { History, CheckCircle, XCircle, Send } from 'lucide-react'
import { fetchAllProjects, projectsQueryKeys } from '../lib/db/projects'
import { fetchCandidates } from '../lib/db/candidates'
import { fetchSubmissionsByProject } from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import { useState } from 'react'
import type { Project } from '../lib/db/projects'
import type { Candidate } from '../lib/db/candidates'
import type { Submission } from '../lib/db/submissions'
import type { DataEnv } from '../lib/dataEnv'

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function HistoryPage({ dataEnv }: { dataEnv: DataEnv }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const queryClient = useQueryClient()

  const { data: projects = [] } = useQuery({
    queryKey: projectsQueryKeys.all(dataEnv),
    queryFn: () => fetchAllProjects(dataEnv),
  })
  const { data: candidates = [] } = useQuery({
    queryKey: ['candidates', dataEnv],
    queryFn: () => fetchCandidates(dataEnv),
  })
  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ['submissions', dataEnv, selectedProjectId],
    queryFn: () => fetchSubmissionsByProject(selectedProjectId, dataEnv),
    enabled: !!selectedProjectId,
  })

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Submission['status'] }) => {
      const { error } = await supabase.from('submissions').update({ status }).eq('id', id).eq('data_env', dataEnv)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['submissions', dataEnv, selectedProjectId] }),
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

  const getCandidate = (id: string) =>
    (candidates as Candidate[]).find((c) => c.id === id)

  const getProject = (id: string) =>
    (projects as Project[]).find((p) => p.id === id)

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

      {selectedProjectId && (() => {
        const proj = getProject(selectedProjectId)
        return (
          <>
            {/* 案件詳細サマリ */}
            {proj && (
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-gray-800">{proj.title}</span>
                  {proj.client && <span className="text-xs text-gray-500">{proj.client}</span>}
                  {proj.industry && <span className="text-xs text-gray-500">{proj.industry}</span>}
                  {proj.contract_type && <span className="text-xs text-gray-500">{proj.contract_type}</span>}
                  {proj.headcount != null && <span className="text-xs text-gray-500">募集{proj.headcount}名</span>}
                  {proj.budget_min != null && (
                    <span className="text-xs text-gray-500">予算: {proj.budget_min}〜{proj.budget_max ?? '?'}万</span>
                  )}
                  {proj.start_date && <span className="text-xs text-gray-400">開始: {proj.start_date}</span>}
                  {proj.end_date && <span className="text-xs text-gray-400">終了: {proj.end_date}</span>}
                  {proj.work_location && <span className="text-xs text-gray-400">勤務: {proj.work_location}</span>}
                  {proj.remote_policy && <span className="text-xs text-gray-400">{proj.remote_policy}</span>}
                  {proj.role_summary && <span className="text-xs text-gray-400">{proj.role_summary}</span>}
                </div>
                {proj.description && (
                  <p className="text-xs text-gray-500 leading-relaxed">{proj.description}</p>
                )}
                {(proj.required_skills as string[]).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {(proj.required_skills as string[]).map((s) => (
                      <span key={s} className="text-xs bg-purple-50 text-purple-700 rounded px-1.5 py-0.5">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              {isLoading ? (
                <p className="text-sm text-gray-400">読み込み中...</p>
              ) : (submissions as Submission[]).length === 0 ? (
                <p className="text-sm text-gray-400">この案件の提案履歴はありません</p>
              ) : (
                <div className="space-y-3">
                  {(submissions as Submission[]).map((s) => {
                    const cand = getCandidate(s.candidate_id)
                    return (
                      <div key={s.id} className="border border-gray-100 rounded-lg p-4 flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm text-gray-800">{cand?.name ?? '不明'}</span>
                            <span className={`text-xs rounded px-2 py-0.5 ${statusColor[s.status]}`}>
                              {statusLabel[s.status]}
                            </span>
                            <span className="text-sm font-bold text-gray-600">Score: {s.match_score}</span>
                          </div>
                          {cand && (
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-400">
                              {cand.email && <span>{cand.email}</span>}
                              {cand.experience_years != null && <span>経験{cand.experience_years}年</span>}
                            </div>
                          )}
                          {cand && (cand.skills as string[]).length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {(cand.skills as string[]).map((sk) => (
                                <span key={sk} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{sk}</span>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-gray-400">{s.ai_summary}</p>
                          <p className="text-xs text-gray-300">{formatDate(s.created_at)}</p>
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
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )
      })()}
    </div>
  )
}
