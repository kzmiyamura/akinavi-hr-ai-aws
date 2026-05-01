import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Star, AlertTriangle, Briefcase, User } from 'lucide-react'
import { ai } from '../lib/ai'
import { fetchCandidates } from '../lib/db/candidates'
import { fetchOpenProjects, projectToMatchRequirements } from '../lib/db/projects'
import {
  upsertSubmission,
  fetchSubmissionsByProject,
  fetchSubmissionsByCandidateWithProjects,
} from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import type { Candidate } from '../lib/db/candidates'
import type { Project } from '../lib/db/projects'
import type { Submission } from '../lib/db/submissions'

interface Props { nickname: string }

interface RankedSubmission extends Submission {
  candidate: Candidate
}

type MatchMode = 'project' | 'candidate'

export function MatchingPage({ nickname }: Props) {
  const [mode, setMode] = useState<MatchMode>('project')
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const queryClient = useQueryClient()

  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: fetchOpenProjects })
  const { data: candidates = [] } = useQuery({ queryKey: ['candidates'], queryFn: fetchCandidates })

  const { data: submissions = [], isLoading: isLoadingSubmissions } = useQuery({
    queryKey: ['submissions', selectedProjectId],
    queryFn: () => fetchSubmissionsByProject(selectedProjectId),
    enabled: !!selectedProjectId && mode === 'project',
  })

  const { data: candidateRanking = [], isLoading: isLoadingCandidateRanking } = useQuery({
    queryKey: ['submissions-by-candidate', selectedCandidateId],
    queryFn: () => fetchSubmissionsByCandidateWithProjects(selectedCandidateId),
    enabled: !!selectedCandidateId && mode === 'candidate',
  })

  const ranked: RankedSubmission[] = submissions
    .map((s: Submission) => ({
      ...s,
      candidate: (candidates as Candidate[]).find((c) => c.id === s.candidate_id)!,
    }))
    .filter((s) => s.candidate)

  const matchByProjectMutation = useMutation({
    mutationFn: async () => {
      const project = (projects as Project[]).find((p) => p.id === selectedProjectId)
      if (!project) throw new Error('案件を選択してください')

      const projectReq = projectToMatchRequirements(project)

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

  const matchByCandidateMutation = useMutation({
    mutationFn: async () => {
      const candidate = (candidates as Candidate[]).find((c) => c.id === selectedCandidateId)
      if (!candidate) throw new Error('人材を選択してください')
      if ((projects as Project[]).length === 0) throw new Error('募集中の案件がありません')

      const candidateProfile = {
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        skills: candidate.skills as string[],
        experienceYears: candidate.experience_years,
        summary: (candidate.raw_profile as { summary?: string }).summary ?? '',
      }

      for (const project of projects as Project[]) {
        const projectReq = projectToMatchRequirements(project)
        const matchResult = await ai.matchCandidateToProject({ candidateProfile, projectRequirements: projectReq })

        if (matchResult.duplicateSuspected && !candidate.duplicate_flag) {
          await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', candidate.id)
        }

        await upsertSubmission({
          candidateId: candidate.id,
          projectId: project.id,
          matchResult,
          createdBy: nickname,
        })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['submissions-by-candidate', selectedCandidateId] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setMessage({ type: 'success', text: 'マッチング完了（この人材 × 募集中の全案件）' })
    },
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const scoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600 bg-green-50'
    if (score >= 60) return 'text-yellow-600 bg-yellow-50'
    return 'text-gray-500 bg-gray-50'
  }

  const switchMode = (next: MatchMode) => {
    setMode(next)
    setMessage(null)
  }

  return (
    <div className="space-y-6">
      <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-1 w-fit gap-1">
        <button
          type="button"
          onClick={() => switchMode('project')}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            mode === 'project'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <Briefcase size={16} className="text-blue-600" />
          案件から見る
        </button>
        <button
          type="button"
          onClick={() => switchMode('candidate')}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            mode === 'candidate'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <User size={16} className="text-blue-600" />
          人材から見る
        </button>
      </div>

      {mode === 'project' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
              <Star size={18} className="text-blue-600" />
              マッチング実行（1案件 × 全人材）
            </h2>
            <p className="text-sm text-gray-500">
              選んだ案件に対し、登録されている全人材を AI がスコアリングします。
            </p>

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
                onClick={() => { setMessage(null); matchByProjectMutation.mutate() }}
                disabled={
                  !selectedProjectId
                  || (candidates as Candidate[]).length === 0
                  || matchByProjectMutation.isPending
                }
                className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {matchByProjectMutation.isPending
                  ? <Loader2 size={16} className="animate-spin" />
                  : <Star size={16} />}
                {matchByProjectMutation.isPending
                  ? `スコアリング中…（全${(candidates as Candidate[]).length}名）`
                  : 'AI マッチング実行'}
              </button>
            </div>

            {message && mode === 'project' && (
              <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {message.text}
              </p>
            )}
          </div>

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
                            <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                              経験{s.candidate.experience_years}年
                            </span>
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
        </>
      )}

      {mode === 'candidate' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
              <Star size={18} className="text-blue-600" />
              マッチング実行（1人材 × 募集中の全案件）
            </h2>
            <p className="text-sm text-gray-500">
              選んだ人材に対し、ステータスが「募集中」の全案件を AI がスコアリングします。下の一覧は過去のマッチング結果（高い順）です。
            </p>

            <div className="flex gap-3 flex-wrap">
              <select
                value={selectedCandidateId}
                onChange={(e) => { setSelectedCandidateId(e.target.value); setMessage(null) }}
                className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">人材を選択...</option>
                {(candidates as Candidate[]).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ''}</option>
                ))}
              </select>
              <button
                onClick={() => { setMessage(null); matchByCandidateMutation.mutate() }}
                disabled={
                  !selectedCandidateId
                  || (projects as Project[]).length === 0
                  || matchByCandidateMutation.isPending
                }
                className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {matchByCandidateMutation.isPending
                  ? <Loader2 size={16} className="animate-spin" />
                  : <Star size={16} />}
                {matchByCandidateMutation.isPending
                  ? `スコアリング中…（全${(projects as Project[]).length}件）`
                  : 'AI マッチング実行'}
              </button>
            </div>

            {message && mode === 'candidate' && (
              <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {message.text}
              </p>
            )}
          </div>

          {selectedCandidateId && (
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-base font-semibold text-gray-800 mb-4">
                おすすめ案件（スコア順・{candidateRanking.length}件）
              </h2>
              {isLoadingCandidateRanking ? (
                <p className="text-sm text-gray-400">読み込み中...</p>
              ) : candidateRanking.length === 0 ? (
                <p className="text-sm text-gray-400">
                  まだマッチング結果がありません。「AI マッチング実行」で算出してください。
                </p>
              ) : (
                <div className="space-y-3">
                  {candidateRanking.map(({ submission: s, project: p }, i) => (
                    <div key={s.id} className="border border-gray-100 rounded-lg p-4 flex items-start gap-4">
                      <div className="text-2xl font-bold text-gray-300 w-8 text-center shrink-0">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-gray-800 text-sm">
                            {p?.title ?? '（案件データなし）'}
                          </span>
                          {p?.client && (
                            <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{p.client}</span>
                          )}
                          {p && (
                            <span className="text-xs rounded px-1.5 py-0.5 bg-slate-100 text-slate-700">
                              {p.status === 'open' ? '募集中' : p.status === 'filled' ? '充足' : '終了'}
                            </span>
                          )}
                        </div>
                        {p?.work_location && (
                          <p className="text-xs text-gray-400 mt-0.5">{p.work_location}</p>
                        )}
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
        </>
      )}
    </div>
  )
}
