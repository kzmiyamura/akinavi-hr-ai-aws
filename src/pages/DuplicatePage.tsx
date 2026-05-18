import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, GitMerge, Trash2 } from 'lucide-react'
import { fetchDuplicateCandidates, fetchCandidates } from '../lib/db/candidates'
import { supabase } from '../lib/supabase'
import { useState } from 'react'
import type { Candidate } from '../lib/db/candidates'
import type { DataEnv } from '../lib/dataEnv'

export function DuplicatePage({ dataEnv, onOpenCandidateDetail }: { dataEnv: DataEnv; onOpenCandidateDetail?: (id: string) => void }) {
  const queryClient = useQueryClient()
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({})

  const { data: duplicates = [], isLoading } = useQuery({
    queryKey: ['duplicates', dataEnv],
    queryFn: () => fetchDuplicateCandidates(dataEnv),
  })
  const { data: allCandidates = [] } = useQuery({
    queryKey: ['candidates', dataEnv],
    queryFn: () => fetchCandidates(dataEnv),
  })

  // フラグ解除（重複ではないと判断）
  const clearFlagMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('candidates').update({ duplicate_flag: false }).eq('id', id).eq('data_env', dataEnv)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['duplicates', dataEnv] })
      queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
    },
  })

  // 名寄せ（マージ）: 重複候補を merged_into にセットして論理削除
  const mergeMutation = useMutation({
    mutationFn: async ({ sourceId, targetId }: { sourceId: string; targetId: string }) => {
      const { error } = await supabase
        .from('candidates')
        .update({ merged_into: targetId, duplicate_flag: false })
        .eq('id', sourceId)
        .eq('data_env', dataEnv)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['duplicates', dataEnv] })
      queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
    },
  })

  const mergeOptions = (excludeId: string) =>
    (allCandidates as Candidate[]).filter((c) => c.id !== excludeId)

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2 mb-2">
          <AlertTriangle size={18} className="text-yellow-500" />
          重複の疑いがある人材（{(duplicates as Candidate[]).length}件）
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          AI が「名前やスキルが類似している」と判断した人材の一覧です。
          内容を確認し、「名寄せ（統合）」または「重複ではない」を選択してください。
        </p>

        {isLoading ? (
          <p className="text-sm text-gray-400">読み込み中...</p>
        ) : (duplicates as Candidate[]).length === 0 ? (
          <p className="text-sm text-gray-400">重複の疑いがある人材はいません</p>
        ) : (
          <div className="space-y-4">
            {(duplicates as Candidate[]).map((c) => (
              <div key={c.id} className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 space-y-3">
                <div>
                  {onOpenCandidateDetail ? (
                    <button
                      type="button"
                      onClick={() => onOpenCandidateDetail(c.id)}
                      className="font-medium text-gray-800 text-sm text-left hover:text-blue-700 hover:underline"
                    >
                      {c.name}
                    </button>
                  ) : (
                    <p className="font-medium text-gray-800 text-sm">{c.name}</p>
                  )}
                  <p className="text-xs text-gray-500">
                    {c.email ?? 'メールなし'} ／ 経験{c.experience_years ?? '?'}年
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(c.skills as string[]).map((s) => (
                      <span key={s} className="text-xs bg-white text-blue-700 border border-blue-100 rounded px-1.5 py-0.5">{s}</span>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 flex-wrap items-center">
                  {/* 名寄せ先を選択してマージ */}
                  <select
                    value={mergeTarget[c.id] ?? ''}
                    onChange={(e) => setMergeTarget((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">統合先を選択...</option>
                    {mergeOptions(c.id).map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.name}（{opt.email ?? 'メールなし'}）</option>
                    ))}
                  </select>
                  <button
                    onClick={() => mergeMutation.mutate({ sourceId: c.id, targetId: mergeTarget[c.id] })}
                    disabled={!mergeTarget[c.id] || mergeMutation.isPending}
                    className="flex items-center gap-1 text-sm bg-blue-600 text-white rounded-lg px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <GitMerge size={14} />
                    名寄せ（統合）
                  </button>
                  <button
                    onClick={() => clearFlagMutation.mutate(c.id)}
                    disabled={clearFlagMutation.isPending}
                    className="flex items-center gap-1 text-sm bg-white text-gray-600 border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
                  >
                    <Trash2 size={14} />
                    重複ではない
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
