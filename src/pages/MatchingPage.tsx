import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Star, AlertTriangle } from 'lucide-react'
import { ai } from '../lib/ai'
import { fetchCandidates } from '../lib/db/candidates'
import { fetchOpenProjects } from '../lib/db/projects'
import { upsertSubmission, fetchSubmissionsByProject } from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import type { Candidate } from '../lib/db/candidates'
import type { AnalyzeProjectResponse } from '../lib/ai/types'
import type { Project } from '../lib/db/projects'
import type { Submission } from '../lib/db/submissions'

interface Props { nickname: string }

interface RankedSubmission extends Submission {
  candidate: Candidate
}

export function MatchingPage({ nickname }: Props) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const queryClient = useQueryClient()

  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: fetchOpenProjects })
  const { data: candidates = [] } = useQuery({ queryKey: ['candidates'], queryFn: fetchCandidates })

  const { data: submissions = [], isLoading: isLoadingSubmissions } = useQuery({
    queryKey: ['submissions', selectedProjectId],
    queryFn: () => fetchSubmissionsByProject(selectedProjectId),
    enabled: !!selectedProjectId,
  })

  // 候補者情報をマージしたランキング
  const ranked: RankedSubmission[] = submissions
    .map((s: Submission) => ({
      ...s,
      candidate: (candidates as Candidate[]).find((c) => c.id === s.candidate_id)!,
    }))
    .filter((s) => s.candidate)

  // 全候補者 × 選択案件をAIでスコアリング
  const matchMutation = useMutation({
    mutationFn: async () => {
      const project = (projects as Project[]).find((p) => p.id === selectedProjectId)
      if (!project) throw new Error('案件を選択してください')

      const projectReq: AnalyzeProjectResponse = {
        title: project.title,
        client: project.client,
        description: project.description,
        requiredSkills: project.required_skills as string[],
        budgetMin: project.budget_min,
        budgetMax: project.budget_max,
        startDate: project.start_date,
        endDate: project.end_date,
        workLocation: project.work_location,
        remotePolicy: project.remote_policy,
        contractType: project.contract_type,
        headcount: project.headcount,
        workload: project.workload,
        settlementMin: project.settlement_min,
        settlementMax: project.settlement_max,
        roleSummary: project.role_summary,
        industry: project.industry,
        niceToHaveSkills: (project.raw_data?.niceToHaveSkills as string[] | undefined) ?? [],
      }

      for (const candidate of candidates as Candidate[]) {
        const candidateProfile = {
          name: candidate.name,
          email: candidate.email,
          phone: candidate.phone,
          skills: candidate.skills as string[],
          experienceYears: candidate.experience_years,
          summary: (candidate.raw_profile as { summary?: string }).summary ?? '',
        }
        const matchResult = await ai.matchCandidateToProject({ candidateProfile, projectRequirements: projectReq })

        // duplicate_flag 更新
        if (matchResult.duplicateSuspected && !candidate.duplicate_flag) {
          await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', candidate.id)
        }

        await upsertSubmission({ candidateId: candidate.id, projectId: selectedProjectId, matchResult, createdBy: nickname })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['submissions', selectedProjectId] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setMessage({ type: 'success', text: 'マッチング完了' })
    },
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const scoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600 bg-green-50'
    if (score >= 60) return 'text-yellow-600 bg-yellow-50'
    return 'text-gray-500 bg-gray-50'
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
          <Star size={18} className="text-blue-600" />
          マッチング実行
        </h2>

        <div className="flex gap-3 flex-wrap">
          <select
            value={selectedProjectId}
            onChange={(e) => { setSelectedProjectId(e.target.value); setMessage(null) }}
            className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">案件を選択...</option>
            {(projects as Project[]).map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
          <button
            onClick={() => { setMessage(null); matchMutation.mutate() }}
            disabled={!selectedProjectId || (candidates as Candidate[]).length === 0 || matchMutation.isPending}
            className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {matchMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Star size={16} />}
            {matchMutation.isPending ? `スコアリング中 (0/${(candidates as Candidate[]).length}件)...` : 'AI マッチング実行'}
          </button>
        </div>

        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </p>
        )}
      </div>

      {/* ランキング */}
      {selectedProjectId && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">
            マッチングランキング（{ranked.length}件）
          </h2>
          {isLoadingSubmissions ? (
            <p className="text-sm text-gray-400">読み込み中...</p>
          ) : ranked.length === 0 ? (
            <p className="text-sm text-gray-400">「AI マッチング実行」でスコアを算出してください</p>
          ) : (
            <div className="space-y-3">
              {ranked.map((s, i) => (
                <div key={s.id} className="border border-gray-100 rounded-lg p-4 flex items-start gap-4">
                  <div className="text-2xl font-bold text-gray-300 w-8 text-center shrink-0">{i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-800 text-sm">{s.candidate.name}</span>
                      {s.candidate.experience_years != null && (
                        <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">経験{s.candidate.experience_years}年</span>
                      )}
                      {s.candidate.duplicate_flag && (
                        <span className="flex items-center gap-1 text-xs bg-yellow-100 text-yellow-700 rounded px-2 py-0.5">
                          <AlertTriangle size={11} />重複の疑い
                        </span>
                      )}
                    </div>
                    {s.candidate.email && (
                      <p className="text-xs text-gray-400 mt-0.5">{s.candidate.email}</p>
                    )}
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(s.candidate.skills as string[]).map((sk) => (
                        <span key={sk} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{sk}</span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-1.5">{s.ai_summary}</p>
                  </div>
                  <div className={`text-2xl font-bold rounded-lg px-3 py-1 shrink-0 ${scoreColor(s.match_score)}`}>
                    {s.match_score}
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
