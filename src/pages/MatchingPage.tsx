import { useState, useMemo, Fragment, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertTriangle, Briefcase, User, RefreshCw, ChevronDown } from 'lucide-react'
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

/** 一覧に出す件数。それ以上はアコーディオン内へ */
const RANK_HEAD = 5
/** スキルタグの常時表示数。それ以上はアコーディオン内へ */
const SKILL_HEAD = 12

const accordionSummaryCls =
  'flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden'

function SkillTagsWithAccordion({ skills }: { skills: string[] }) {
  if (skills.length === 0) return null
  if (skills.length <= SKILL_HEAD) {
    return (
      <div className="flex flex-wrap gap-1 mt-1">
        {skills.map((sk) => (
          <span key={sk} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
            {sk}
          </span>
        ))}
      </div>
    )
  }
  const rest = skills.length - SKILL_HEAD
  return (
    <div className="mt-1 space-y-2">
      <div className="flex flex-wrap gap-1">
        {skills.slice(0, SKILL_HEAD).map((sk) => (
          <span key={sk} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
            {sk}
          </span>
        ))}
      </div>
      <details className="group rounded-md border border-slate-200 bg-slate-50/90">
        <summary
          className={`${accordionSummaryCls} px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-slate-100 rounded-md text-left break-words`}
        >
          <ChevronDown size={14} className="shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
          <span className="min-w-0">スキルをさらに表示（{rest} 件）</span>
        </summary>
        <div className="flex flex-wrap gap-1 px-2.5 pb-2 pt-1 border-t border-slate-100">
          {skills.slice(SKILL_HEAD).map((sk) => (
            <span key={sk} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
              {sk}
            </span>
          ))}
        </div>
      </details>
    </div>
  )
}

function RankingRestAccordion({
  count,
  unitLabel,
  children,
}: {
  count: number
  /** 例: 「名」「件の案件」 */
  unitLabel: string
  children: ReactNode
}) {
  if (count <= 0) return null
  return (
    <details className="group mt-3 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
      <summary
        className={`${accordionSummaryCls} px-3 sm:px-4 py-3 text-xs sm:text-sm font-medium text-blue-800 bg-slate-50 hover:bg-slate-100 border-b border-slate-100 break-words text-left`}
      >
        <ChevronDown size={18} className="shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
        <span className="min-w-0">
          さらに {count}
          {unitLabel}のマッチング結果（スコア・理由）
        </span>
      </summary>
      <div className="space-y-3 px-3 sm:px-4 py-4 bg-slate-50/40 min-w-0">{children}</div>
    </details>
  )
}

function ProjectModeRankCard({
  s,
  rankIndex,
  onOpenCandidateDetail,
  scoreColor,
}: {
  s: RankedSubmission
  rankIndex: number
  onOpenCandidateDetail?: (candidateId: string) => void
  scoreColor: (score: number) => string
}) {
  return (
    <div className="border border-gray-100 rounded-lg p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-start bg-white min-w-0">
      <div className="flex gap-3 min-w-0 flex-1">
        <div className="text-xl sm:text-2xl font-bold text-gray-300 w-7 sm:w-8 text-center shrink-0">
          {rankIndex + 1}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {onOpenCandidateDetail ? (
              <button
                type="button"
                onClick={() => onOpenCandidateDetail(s.candidate.id)}
                className="font-medium text-gray-800 text-sm text-left hover:text-blue-700 hover:underline break-words"
              >
                {s.candidate.name}
              </button>
            ) : (
              <span className="font-medium text-gray-800 text-sm break-words">{s.candidate.name}</span>
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
            <p className="text-xs text-gray-400 mt-0.5 break-all">{s.candidate.email}</p>
          )}
          <SkillTagsWithAccordion skills={s.candidate.skills as string[]} />
          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2 min-w-0">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words leading-relaxed">
              {s.ai_summary || '（理由テキストなし）'}
            </p>
          </div>
        </div>
      </div>
      <div
        className={`flex sm:flex-col items-center justify-center gap-1 rounded-lg px-4 py-2 sm:py-1 sm:px-3 shrink-0 self-stretch sm:self-start text-center text-xl sm:text-2xl font-bold ${scoreColor(s.match_score)}`}
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 sm:hidden">スコア</span>
        {s.match_score}
      </div>
    </div>
  )
}

function CandidateModeRankCard({
  s,
  rankIndex,
  p,
  onOpenProjectDetail,
  scoreColor,
}: {
  s: Submission
  rankIndex: number
  p: Project | null
  onOpenProjectDetail?: (projectId: string) => void
  scoreColor: (score: number) => string
}) {
  return (
    <div className="border border-gray-100 rounded-lg p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-start bg-white min-w-0">
      <div className="flex gap-3 min-w-0 flex-1">
        <div className="text-xl sm:text-2xl font-bold text-gray-300 w-7 sm:w-8 text-center shrink-0">
          {rankIndex + 1}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {onOpenProjectDetail ? (
              <button
                type="button"
                onClick={() => onOpenProjectDetail(s.project_id)}
                className="font-medium text-gray-800 text-sm text-left hover:text-blue-700 hover:underline break-words"
              >
                {p?.title ?? '（案件データなし）'}
              </button>
            ) : (
              <span className="font-medium text-gray-800 text-sm break-words">
                {p?.title ?? '（案件データなし）'}
              </span>
            )}
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
            <p className="text-xs text-gray-400 mt-0.5 break-words">{p.work_location}</p>
          )}
          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2 min-w-0">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words leading-relaxed">
              {s.ai_summary || '（理由テキストなし）'}
            </p>
          </div>
        </div>
      </div>
      <div
        className={`flex sm:flex-col items-center justify-center gap-1 rounded-lg px-4 py-2 sm:py-1 sm:px-3 shrink-0 self-stretch sm:self-start text-center text-xl sm:text-2xl font-bold ${scoreColor(s.match_score)}`}
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 sm:hidden">スコア</span>
        {s.match_score}
      </div>
    </div>
  )
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
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-gray-900">マッチング結果一覧</h1>
        <p className="text-sm text-gray-500 mt-1 break-words">
          案件ごと・人材ごとに、保存済みのスコア順ランキングと AI によるマッチング理由をその場で表示します。未実施の行は「マッチング未実施」です。「再実行」でその案件（またはその人材）だけを更新できます。
        </p>
      </div>

      <div className="flex flex-col sm:flex-row rounded-lg border border-gray-200 bg-gray-50 p-1 w-full sm:w-fit gap-1 min-w-0">
        <button
          type="button"
          onClick={() => switchMode('project')}
          className={`flex flex-1 sm:flex-initial items-center justify-center gap-2 rounded-md px-3 sm:px-4 py-2.5 sm:py-2 text-sm font-medium transition-colors min-w-0 ${
            mode === 'project'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <Briefcase size={16} className="text-blue-600 shrink-0" />
          案件から見る
        </button>
        <button
          type="button"
          onClick={() => switchMode('candidate')}
          className={`flex flex-1 sm:flex-initial items-center justify-center gap-2 rounded-md px-3 sm:px-4 py-2.5 sm:py-2 text-sm font-medium transition-colors min-w-0 ${
            mode === 'candidate'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <User size={16} className="text-blue-600 shrink-0" />
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
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
          <div className="px-3 sm:px-6 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:flex-wrap sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-800">募集中の案件</h2>
              <p className="text-sm text-gray-500 mt-0.5 break-words">
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
              className="inline-flex w-full sm:w-auto items-center justify-center gap-2 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-2.5 sm:py-2 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {bulkAllProjectsMutation.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              全案件×全人材を再マッチング
            </button>
          </div>
          {(projects as Project[]).length === 0 ? (
            <p className="text-sm text-gray-400 px-3 sm:px-6 py-8">募集中の案件がありません。</p>
          ) : (
            <div className="overflow-x-auto -mx-0 sm:mx-0 touch-pan-x">
              <table className="min-w-[20rem] w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500 bg-gray-50/80">
                    <th className="py-3 px-3 sm:px-6 font-medium">案件</th>
                    <th className="py-3 pr-3 sm:pr-4 font-medium whitespace-nowrap hidden md:table-cell">クライアント</th>
                    <th className="py-3 pr-3 sm:pr-4 font-medium min-w-[8rem] sm:min-w-[10rem]">状態</th>
                    <th className="py-3 px-3 sm:px-6 font-medium text-right whitespace-nowrap">操作</th>
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
                          <td className="py-3 px-3 sm:px-6 font-medium text-gray-900 max-w-[12rem] sm:max-w-none">
                            {onOpenProjectDetail ? (
                              <button
                                type="button"
                                onClick={() => onOpenProjectDetail(p.id)}
                                className="text-left text-blue-700 hover:text-blue-900 hover:underline font-medium break-words w-full"
                              >
                                {p.title}
                              </button>
                            ) : (
                              <span className="break-words">{p.title}</span>
                            )}
                          </td>
                          <td className="py-3 pr-3 sm:pr-4 text-gray-600 hidden md:table-cell whitespace-nowrap">
                            {p.client ?? '—'}
                          </td>
                          <td className="py-3 pr-3 sm:pr-4">
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
                          <td className="py-3 px-3 sm:px-6 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setMessage(null)
                                matchByProjectMutation.mutate(p.id)
                              }}
                              disabled={(candidates as Candidate[]).length === 0 || busy}
                              className="inline-flex items-center justify-center gap-1 bg-blue-600 text-white rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
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
                            <td colSpan={4} className="px-3 sm:px-6 py-4 min-w-0">
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
                                    {ranked.length > RANK_HEAD && (
                                      <span className="text-gray-400">（先頭 {RANK_HEAD} 名を常時表示）</span>
                                    )}
                                  </p>
                                  <div className="space-y-3">
                                    {ranked.slice(0, RANK_HEAD).map((s, i) => (
                                      <ProjectModeRankCard
                                        key={s.id}
                                        s={s}
                                        rankIndex={i}
                                        onOpenCandidateDetail={onOpenCandidateDetail}
                                        scoreColor={scoreColor}
                                      />
                                    ))}
                                    <RankingRestAccordion
                                      count={ranked.length - RANK_HEAD}
                                      unitLabel="名"
                                    >
                                      {ranked.slice(RANK_HEAD).map((s, idx) => (
                                        <ProjectModeRankCard
                                          key={s.id}
                                          s={s}
                                          rankIndex={RANK_HEAD + idx}
                                          onOpenCandidateDetail={onOpenCandidateDetail}
                                          scoreColor={scoreColor}
                                        />
                                      ))}
                                    </RankingRestAccordion>
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
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
          <div className="px-3 sm:px-6 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:flex-wrap sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-800">登録人材</h2>
              <p className="text-sm text-gray-500 mt-0.5 break-words">
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
              className="inline-flex w-full sm:w-auto items-center justify-center gap-2 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-2.5 sm:py-2 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {bulkAllCandidatesMutation.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              全人材×全案件を再マッチング
            </button>
          </div>
          {(candidates as Candidate[]).length === 0 ? (
            <p className="text-sm text-gray-400 px-3 sm:px-6 py-8">登録人材がありません。</p>
          ) : (
            <div className="overflow-x-auto touch-pan-x">
              <table className="min-w-[18rem] w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500 bg-gray-50/80">
                    <th className="py-3 px-3 sm:px-6 font-medium">人材</th>
                    <th className="py-3 pr-3 sm:pr-4 font-medium min-w-[8rem] sm:min-w-[10rem]">状態</th>
                    <th className="py-3 px-3 sm:px-6 font-medium text-right whitespace-nowrap">操作</th>
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
                          <td className="py-3 px-3 sm:px-6 max-w-[11rem] sm:max-w-none min-w-0">
                            {onOpenCandidateDetail ? (
                              <button
                                type="button"
                                onClick={() => onOpenCandidateDetail(c.id)}
                                className="font-medium text-gray-900 text-left hover:text-blue-700 hover:underline block w-full break-words"
                              >
                                {c.name}
                              </button>
                            ) : (
                              <div className="font-medium text-gray-900 break-words">{c.name}</div>
                            )}
                            {c.email && (
                              <div className="text-xs text-gray-500 mt-0.5 break-all">{c.email}</div>
                            )}
                          </td>
                          <td className="py-3 pr-3 sm:pr-4">
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
                          <td className="py-3 px-3 sm:px-6 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setMessage(null)
                                matchByCandidateMutation.mutate(c.id)
                              }}
                              disabled={(projects as Project[]).length === 0 || busy}
                              className="inline-flex items-center justify-center gap-1 bg-blue-600 text-white rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
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
                            <td colSpan={3} className="px-3 sm:px-6 py-4 min-w-0">
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
                                    {subs.length > RANK_HEAD && (
                                      <span className="text-gray-400">（先頭 {RANK_HEAD} 件を常時表示）</span>
                                    )}
                                  </p>
                                  <div className="space-y-3">
                                    {subs.slice(0, RANK_HEAD).map((s, i) => {
                                      const p = projectById.get(s.project_id) ?? null
                                      return (
                                        <CandidateModeRankCard
                                          key={s.id}
                                          s={s}
                                          rankIndex={i}
                                          p={p}
                                          onOpenProjectDetail={onOpenProjectDetail}
                                          scoreColor={scoreColor}
                                        />
                                      )
                                    })}
                                    <RankingRestAccordion
                                      count={subs.length - RANK_HEAD}
                                      unitLabel="件"
                                    >
                                      {subs.slice(RANK_HEAD).map((s, idx) => {
                                        const p = projectById.get(s.project_id) ?? null
                                        return (
                                          <CandidateModeRankCard
                                            key={s.id}
                                            s={s}
                                            rankIndex={RANK_HEAD + idx}
                                            p={p}
                                            onOpenProjectDetail={onOpenProjectDetail}
                                            scoreColor={scoreColor}
                                          />
                                        )
                                      })}
                                    </RankingRestAccordion>
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
