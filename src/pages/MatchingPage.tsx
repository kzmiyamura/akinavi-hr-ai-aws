import { useState, useMemo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertTriangle, Briefcase, User, RefreshCw } from 'lucide-react'
import { ai } from '../lib/ai'
import { fetchCandidates } from '../lib/db/candidates'
import {
  fetchOpenProjects,
  projectToMatchRequirements,
  projectsQueryKeys,
  fetchProjectsByIds,
} from '../lib/db/projects'
import {
  upsertSubmission,
  fetchSubmissionsByProjectIds,
  fetchSubmissionsByCandidateIds,
  fetchSubmissionStats,
} from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import type { Candidate } from '../lib/db/candidates'
import type { Project } from '../lib/db/projects'
import type { Submission } from '../lib/db/submissions'

interface Props {
  nickname: string
  onOpenCandidateDetail?: (candidateId: string) => void
  onOpenProjectDetail?: (projectId: string) => void
}

interface RankedSubmission extends Submission {
  candidate: Candidate
}

type MatchMode = 'project' | 'candidate'

function groupSubmissionsByProject(rows: Submission[]): Map<string, Submission[]> {
  const m = new Map<string, Submission[]>()
  for (const s of rows) {
    const arr = m.get(s.project_id) ?? []
    arr.push(s)
    m.set(s.project_id, arr)
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => b.match_score - a.match_score)
  }
  return m
}

function groupSubmissionsByCandidate(rows: Submission[]): Map<string, Submission[]> {
  const m = new Map<string, Submission[]>()
  for (const s of rows) {
    const arr = m.get(s.candidate_id) ?? []
    arr.push(s)
    m.set(s.candidate_id, arr)
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => b.match_score - a.match_score)
  }
  return m
}

function toRankedForProject(subs: Submission[], allCandidates: Candidate[]): RankedSubmission[] {
  return subs
    .map((s) => ({
      ...s,
      candidate: allCandidates.find((c) => c.id === s.candidate_id)!,
    }))
    .filter((s): s is RankedSubmission => Boolean(s.candidate))
}

export function MatchingPage({
  nickname,
  onOpenCandidateDetail,
  onOpenProjectDetail,
}: Props) {
  const [mode, setMode] = useState<MatchMode>('project')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const queryClient = useQueryClient()

  const { data: projects = [] } = useQuery({ queryKey: projectsQueryKeys.open, queryFn: fetchOpenProjects })
  const { data: candidates = [] } = useQuery({ queryKey: ['candidates'], queryFn: fetchCandidates })
  const { data: stats, isLoading: isLoadingStats } = useQuery({
    queryKey: ['submission-stats'],
    queryFn: fetchSubmissionStats,
  })

  const projectList = projects as Project[]
  const candidateList = candidates as Candidate[]

  const projectIdsSorted = useMemo(
    () => [...projectList.map((p) => p.id)].sort().join(','),
    [projectList],
  )
  const candidateIdsSorted = useMemo(
    () => [...candidateList.map((c) => c.id)].sort().join(','),
    [candidateList],
  )

  const { data: submissionsForProjects = [], isLoading: isLoadingProjectSubs } = useQuery({
    queryKey: ['matching-submissions-by-projects', projectIdsSorted],
    queryFn: () => fetchSubmissionsByProjectIds(projectList.map((p) => p.id)),
    enabled: mode === 'project' && projectList.length > 0,
  })

  const { data: submissionsForCandidates = [], isLoading: isLoadingCandidateSubs } = useQuery({
    queryKey: ['matching-submissions-by-candidates', candidateIdsSorted],
    queryFn: () => fetchSubmissionsByCandidateIds(candidateList.map((c) => c.id)),
    enabled: mode === 'candidate' && candidateList.length > 0,
  })

  const submissionsByProject = useMemo(
    () => groupSubmissionsByProject(submissionsForProjects),
    [submissionsForProjects],
  )
  const submissionsByCandidate = useMemo(
    () => groupSubmissionsByCandidate(submissionsForCandidates),
    [submissionsForCandidates],
  )

  const uniqueProjectIdsForCandidateView = useMemo(() => {
    const ids = [...new Set(submissionsForCandidates.map((s) => s.project_id))]
    ids.sort()
    return ids
  }, [submissionsForCandidates])
  const uniqueProjectIdsKey = uniqueProjectIdsForCandidateView.join(',')

  const { data: projectsForMatching = [], isLoading: isLoadingSupportProjects } = useQuery({
    queryKey: ['matching-support-projects', uniqueProjectIdsKey],
    queryFn: () => fetchProjectsByIds(uniqueProjectIdsForCandidateView),
    enabled: mode === 'candidate' && uniqueProjectIdsForCandidateView.length > 0,
  })

  const projectById = useMemo(
    () => new Map(projectsForMatching.map((p) => [p.id, p])),
    [projectsForMatching],
  )

  const invalidateMatchingQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['submission-stats'] })
    queryClient.invalidateQueries({ queryKey: ['candidates'] })
    queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-projects'] })
    queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-candidates'] })
    queryClient.invalidateQueries({ queryKey: ['matching-support-projects'] })
  }

  const matchByProjectMutation = useMutation({
    mutationFn: async (projectId: string) => {
      const project = (projects as Project[]).find((p) => p.id === projectId)
      if (!project) throw new Error('案件が見つかりません')

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

        await upsertSubmission({ candidateId: candidate.id, projectId, matchResult, createdBy: nickname })
      }
    },
    onSuccess: () => {
      invalidateMatchingQueries()
      setMessage({ type: 'success', text: 'マッチングを更新しました' })
    },
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const matchByCandidateMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const candidate = (candidates as Candidate[]).find((c) => c.id === candidateId)
      if (!candidate) throw new Error('人材が見つかりません')
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
      invalidateMatchingQueries()
      setMessage({ type: 'success', text: 'マッチングを更新しました（この人材 × 募集中の全案件）' })
    },
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const bulkAllProjectsMutation = useMutation({
    mutationFn: async () => {
      const plist = projects as Project[]
      const clist = candidates as Candidate[]
      const total = plist.length * clist.length
      if (total === 0) return

      let done = 0
      setBulkProgress({ done: 0, total })
      try {
        for (const project of plist) {
          const projectReq = projectToMatchRequirements(project)
          for (const candidate of clist) {
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

            await upsertSubmission({
              candidateId: candidate.id,
              projectId: project.id,
              matchResult,
              createdBy: nickname,
            })
            done += 1
            setBulkProgress({ done, total })
          }
        }
        setMessage({
          type: 'success',
          text: `一括マッチング完了（募集中 ${plist.length} 案件 × 全 ${clist.length} 名）`,
        })
      } finally {
        setBulkProgress(null)
      }
    },
    onSuccess: () => invalidateMatchingQueries(),
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const bulkAllCandidatesMutation = useMutation({
    mutationFn: async () => {
      const plist = projects as Project[]
      const clist = candidates as Candidate[]
      const total = plist.length * clist.length
      if (total === 0) return

      let done = 0
      setBulkProgress({ done: 0, total })
      try {
        for (const candidate of clist) {
          const candidateProfile = {
            name: candidate.name,
            email: candidate.email,
            phone: candidate.phone,
            skills: candidate.skills as string[],
            experienceYears: candidate.experience_years,
            summary: (candidate.raw_profile as { summary?: string }).summary ?? '',
          }
          for (const project of plist) {
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
            done += 1
            setBulkProgress({ done, total })
          }
        }
        setMessage({
          type: 'success',
          text: `一括マッチング完了（全 ${clist.length} 名 × 募集中 ${plist.length} 案件）`,
        })
      } finally {
        setBulkProgress(null)
      }
    },
    onSuccess: () => invalidateMatchingQueries(),
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

  const countByProject = stats?.countByProjectId ?? {}
  const countByCandidate = stats?.countByCandidateId ?? {}

  const busy =
    matchByProjectMutation.isPending ||
    matchByCandidateMutation.isPending ||
    bulkAllProjectsMutation.isPending ||
    bulkAllCandidatesMutation.isPending

  const runBulkAllProjects = () => {
    const plist = projects as Project[]
    const clist = candidates as Candidate[]
    if (plist.length === 0 || clist.length === 0) return
    const maxCalls = plist.length * clist.length
    if (
      !window.confirm(
        `募集中の全 ${plist.length} 案件について、登録済みの全 ${clist.length} 名と AI マッチングを再実行します。\nAPI 呼び出しは最大 ${maxCalls} 回です。よろしいですか？`,
      )
    ) {
      return
    }
    setMessage(null)
    bulkAllProjectsMutation.mutate()
  }

  const runBulkAllCandidates = () => {
    const plist = projects as Project[]
    const clist = candidates as Candidate[]
    if (plist.length === 0 || clist.length === 0) return
    const maxCalls = plist.length * clist.length
    if (
      !window.confirm(
        `全 ${clist.length} 名の人材について、募集中の全 ${plist.length} 案件と AI マッチングを再実行します。\nAPI 呼び出しは最大 ${maxCalls} 回です。よろしいですか？`,
      )
    ) {
      return
    }
    setMessage(null)
    bulkAllCandidatesMutation.mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">マッチング結果一覧</h1>
        <p className="text-sm text-gray-500 mt-1">
          案件ごと・人材ごとに、保存済みのスコア順ランキングと AI によるマッチング理由をその場で表示します。未実施の行は「マッチング未実施」です。「再実行」でその案件（またはその人材）だけを更新できます。
        </p>
      </div>

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

      {bulkProgress && (
        <p className="text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2">
          一括実行中… {bulkProgress.done} / {bulkProgress.total}
        </p>
      )}

      {message && (
        <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {message.text}
        </p>
      )}

      {mode === 'project' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-800">募集中の案件</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                各案件の下に、全人材のスコアとマッチング理由を表示します。一括は募集中の全案件 × 全人材を順に再スコアします。
              </p>
            </div>
            <button
              type="button"
              onClick={runBulkAllProjects}
              disabled={
                (projects as Project[]).length === 0
                || (candidates as Candidate[]).length === 0
                || busy
              }
              className="inline-flex items-center gap-2 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {bulkAllProjectsMutation.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              全案件×全人材を再マッチング
            </button>
          </div>
          {(projects as Project[]).length === 0 ? (
            <p className="text-sm text-gray-400 px-6 py-8">募集中の案件がありません。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500 bg-gray-50/80">
                    <th className="py-3 px-6 font-medium">案件</th>
                    <th className="py-3 pr-4 font-medium whitespace-nowrap">クライアント</th>
                    <th className="py-3 pr-4 font-medium min-w-[10rem]">状態</th>
                    <th className="py-3 px-6 font-medium text-right whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(projects as Project[]).map((p) => {
                    const n = isLoadingStats ? null : (countByProject[p.id] ?? 0)
                    const rowSpin =
                      matchByProjectMutation.isPending && matchByProjectMutation.variables === p.id
                    const showRanking = !isLoadingStats && n !== null && n > 0
                    const ranked = showRanking
                      ? toRankedForProject(submissionsByProject.get(p.id) ?? [], candidateList)
                      : []
                    return (
                      <Fragment key={p.id}>
                        <tr className="border-b border-gray-50">
                          <td className="py-3 px-6 font-medium text-gray-900">
                            {onOpenProjectDetail ? (
                              <button
                                type="button"
                                onClick={() => onOpenProjectDetail(p.id)}
                                className="text-left text-blue-700 hover:text-blue-900 hover:underline font-medium"
                              >
                                {p.title}
                              </button>
                            ) : (
                              p.title
                            )}
                          </td>
                          <td className="py-3 pr-4 text-gray-600">{p.client ?? '—'}</td>
                          <td className="py-3 pr-4">
                            {isLoadingStats ? (
                              <span className="text-gray-400">読み込み中…</span>
                            ) : n === 0 ? (
                              <span className="text-amber-700 bg-amber-50 rounded px-2 py-0.5 text-xs font-medium">
                                マッチング未実施
                              </span>
                            ) : (
                              <span className="text-gray-700">実施済み（{n}名）</span>
                            )}
                          </td>
                          <td className="py-3 px-6 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setMessage(null)
                                matchByProjectMutation.mutate(p.id)
                              }}
                              disabled={(candidates as Candidate[]).length === 0 || busy}
                              className="inline-flex items-center gap-1 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {rowSpin
                                ? <Loader2 size={14} className="animate-spin" />
                                : <RefreshCw size={14} />}
                              再実行
                            </button>
                          </td>
                        </tr>
                        {showRanking && (
                          <tr className="bg-slate-50/80 border-b border-gray-100">
                            <td colSpan={4} className="px-6 py-4">
                              {isLoadingProjectSubs ? (
                                <p className="text-sm text-gray-400">読み込み中...</p>
                              ) : ranked.length === 0 ? (
                                <p className="text-sm text-gray-500">
                                  データを表示できません。一覧を更新するか「再実行」で算出してください。
                                </p>
                              ) : (
                                <div className="space-y-3">
                                  <p className="text-xs font-medium text-gray-500">
                                    マッチングランキング（全 {ranked.length} 名）— スコアと理由は AI 判定です
                                  </p>
                                  <div className="space-y-3">
                                    {ranked.map((s, i) => (
                                      <div
                                        key={s.id}
                                        className="border border-gray-100 rounded-lg p-4 flex items-start gap-4 bg-white"
                                      >
                                        <div className="text-2xl font-bold text-gray-300 w-8 text-center shrink-0">
                                          {i + 1}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            {onOpenCandidateDetail ? (
                                              <button
                                                type="button"
                                                onClick={() => onOpenCandidateDetail(s.candidate.id)}
                                                className="font-medium text-gray-800 text-sm text-left hover:text-blue-700 hover:underline"
                                              >
                                                {s.candidate.name}
                                              </button>
                                            ) : (
                                              <span className="font-medium text-gray-800 text-sm">{s.candidate.name}</span>
                                            )}
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
                                              <span key={sk} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
                                                {sk}
                                              </span>
                                            ))}
                                          </div>
                                          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2">
                                            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                                              マッチング理由（AI）
                                            </p>
                                            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap leading-relaxed">
                                              {s.ai_summary || '（理由テキストなし）'}
                                            </p>
                                          </div>
                                        </div>
                                        <div
                                          className={`text-2xl font-bold rounded-lg px-3 py-1 shrink-0 ${scoreColor(s.match_score)}`}
                                        >
                                          {s.match_score}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {mode === 'candidate' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-800">登録人材</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                各人材の下に、全案件のスコアとマッチング理由を表示します。一括は全人材 × 募集中の全案件を順に再スコアします。
              </p>
            </div>
            <button
              type="button"
              onClick={runBulkAllCandidates}
              disabled={
                (projects as Project[]).length === 0
                || (candidates as Candidate[]).length === 0
                || busy
              }
              className="inline-flex items-center gap-2 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {bulkAllCandidatesMutation.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              全人材×全案件を再マッチング
            </button>
          </div>
          {(candidates as Candidate[]).length === 0 ? (
            <p className="text-sm text-gray-400 px-6 py-8">登録人材がありません。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500 bg-gray-50/80">
                    <th className="py-3 px-6 font-medium">人材</th>
                    <th className="py-3 pr-4 font-medium min-w-[10rem]">状態</th>
                    <th className="py-3 px-6 font-medium text-right whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(candidates as Candidate[]).map((c) => {
                    const n = isLoadingStats ? null : (countByCandidate[c.id] ?? 0)
                    const rowSpin =
                      matchByCandidateMutation.isPending && matchByCandidateMutation.variables === c.id
                    const showRanking = !isLoadingStats && n !== null && n > 0
                    const subs = submissionsByCandidate.get(c.id) ?? []
                    const subsLoading = isLoadingCandidateSubs || (showRanking && isLoadingSupportProjects)
                    return (
                      <Fragment key={c.id}>
                        <tr className="border-b border-gray-50">
                          <td className="py-3 px-6">
                            {onOpenCandidateDetail ? (
                              <button
                                type="button"
                                onClick={() => onOpenCandidateDetail(c.id)}
                                className="font-medium text-gray-900 text-left hover:text-blue-700 hover:underline block w-full"
                              >
                                {c.name}
                              </button>
                            ) : (
                              <div className="font-medium text-gray-900">{c.name}</div>
                            )}
                            {c.email && (
                              <div className="text-xs text-gray-500 mt-0.5">{c.email}</div>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            {isLoadingStats ? (
                              <span className="text-gray-400">読み込み中…</span>
                            ) : n === 0 ? (
                              <span className="text-amber-700 bg-amber-50 rounded px-2 py-0.5 text-xs font-medium">
                                マッチング未実施
                              </span>
                            ) : (
                              <span className="text-gray-700">実施済み（{n}件の案件）</span>
                            )}
                          </td>
                          <td className="py-3 px-6 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setMessage(null)
                                matchByCandidateMutation.mutate(c.id)
                              }}
                              disabled={(projects as Project[]).length === 0 || busy}
                              className="inline-flex items-center gap-1 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {rowSpin
                                ? <Loader2 size={14} className="animate-spin" />
                                : <RefreshCw size={14} />}
                              再実行
                            </button>
                          </td>
                        </tr>
                        {showRanking && (
                          <tr className="bg-slate-50/80 border-b border-gray-100">
                            <td colSpan={3} className="px-6 py-4">
                              {subsLoading ? (
                                <p className="text-sm text-gray-400">読み込み中...</p>
                              ) : subs.length === 0 ? (
                                <p className="text-sm text-gray-500">
                                  データを表示できません。一覧を更新するか「再実行」で算出してください。
                                </p>
                              ) : (
                                <div className="space-y-3">
                                  <p className="text-xs font-medium text-gray-500">
                                    おすすめ案件（スコア順・全 {subs.length} 件）— スコアと理由は AI 判定です
                                  </p>
                                  <div className="space-y-3">
                                    {subs.map((s, i) => {
                                      const p = projectById.get(s.project_id) ?? null
                                      return (
                                        <div
                                          key={s.id}
                                          className="border border-gray-100 rounded-lg p-4 flex items-start gap-4 bg-white"
                                        >
                                          <div className="text-2xl font-bold text-gray-300 w-8 text-center shrink-0">
                                            {i + 1}
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              {onOpenProjectDetail ? (
                                                <button
                                                  type="button"
                                                  onClick={() => onOpenProjectDetail(s.project_id)}
                                                  className="font-medium text-gray-800 text-sm text-left hover:text-blue-700 hover:underline"
                                                >
                                                  {p?.title ?? '（案件データなし）'}
                                                </button>
                                              ) : (
                                                <span className="font-medium text-gray-800 text-sm">
                                                  {p?.title ?? '（案件データなし）'}
                                                </span>
                                              )}
                                              {p?.client && (
                                                <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                                                  {p.client}
                                                </span>
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
                                            <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2">
                                              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                                                マッチング理由（AI）
                                              </p>
                                              <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap leading-relaxed">
                                                {s.ai_summary || '（理由テキストなし）'}
                                              </p>
                                            </div>
                                          </div>
                                          <div
                                            className={`text-2xl font-bold rounded-lg px-3 py-1 shrink-0 ${scoreColor(s.match_score)}`}
                                          >
                                            {s.match_score}
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
