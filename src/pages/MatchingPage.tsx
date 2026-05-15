import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertTriangle, Briefcase, User, RefreshCw, ChevronDown, CheckCircle, ChevronRight, Search, FileText } from 'lucide-react'
import { toViewerUrl } from '../lib/viewerUrl'
import { fetchCandidates } from '../lib/db/candidates'
import {
  fetchOpenProjects,
  projectToMatchRequirements,
  projectsQueryKeys,
  fetchProjectsByIds,
} from '../lib/db/projects'
import {
  upsertSubmission,
  fetchSubmissionsByProject,
  fetchSubmissionsByCandidate,
  fetchSubmissionStats,
} from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import { getMatchingSettings, MATCHING_DEFAULTS } from '../lib/db/matchingSettings'
import type { Candidate } from '../lib/db/candidates'
import type { Project } from '../lib/db/projects'
import type { Submission } from '../lib/db/submissions'
import type { DataEnv } from '../lib/dataEnv'

async function callMatchScore(
  candidateProfile: unknown,
  projectRequirements: unknown,
): Promise<{ score: number; summary: string; duplicateSuspected: boolean }> {
  const { data, error } = await supabase.functions.invoke('match-score', {
    body: { candidateProfile, projectRequirements },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as { score: number; summary: string; duplicateSuspected: boolean }
}

interface Props {
  nickname: string
  dataEnv: DataEnv
  onOpenCandidateDetail?: (candidateId: string) => void
  onOpenProjectDetail?: (projectId: string) => void
}

interface RankedSubmission extends Submission {
  candidate: Candidate
}

type MatchMode = 'project' | 'candidate'

type MatchingRunMode = 'fast' | 'full'
const MATCHING_RUN_MODE_KEY = 'akinavi.matchingRunMode.v1'

/** マッチング実行中の進捗（一括・単体の「再実行」共通） */
type MatchRunProgress = {
  overall: { done: number; total: number }
  outer?: { current: number; total: number; unit: '案件' | '人材'; detail?: string }
  inner?: { current: number; total: number; unit: '候補者' | '案件' }
}

function truncateProgressLabel(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

function formatMatchRunProgressLine(p: MatchRunProgress): string {
  const chunks: string[] = []
  if (p.outer && p.outer.total > 1) {
    const tail = p.outer.detail ? `（${truncateProgressLabel(p.outer.detail, 32)}）` : ''
    chunks.push(`${p.outer.unit} ${p.outer.current}/${p.outer.total}${tail}`)
  }
  if (p.inner && p.inner.total > 0) {
    chunks.push(`${p.inner.unit} ${p.inner.current}/${p.inner.total} 件目`)
  }
  chunks.push(`全体 ${p.overall.done}/${p.overall.total}`)
  return chunks.join(' · ')
}

function bulkMatchInterruptMessage(done: number, total: number): string {
  return `一括マッチングを中断しました（${done} / ${total} 件まで完了・保存済み）`
}

function normalizeSkillToken(s: string): string {
  return s.trim().toLowerCase()
}

function candidateSkillSet(candidate: Candidate): Set<string> {
  const arr = (candidate.skills as string[] | undefined) ?? []
  return new Set(arr.map((x) => normalizeSkillToken(String(x))).filter((x) => x.length > 0))
}

function countRequiredOverlap(candidate: Candidate, required: string[]): number {
  if (required.length === 0) return 0
  const set = candidateSkillSet(candidate)
  let n = 0
  for (const r of required) {
    const t = normalizeSkillToken(String(r))
    if (!t) continue
    if (set.has(t)) n += 1
  }
  return n
}

function pickCandidatesForProjectMatch(project: Project, allCandidates: Candidate[], mode: MatchingRunMode, maxCandidates = MATCHING_DEFAULTS.fast_max_candidates_per_project): Candidate[] {
  const required = (project.required_skills as string[] | undefined) ?? []
  if (mode === 'full') return allCandidates

  const scored = allCandidates
    .map((c) => ({
      c,
      overlap: countRequiredOverlap(c, required),
      exp: c.experience_years ?? -1,
    }))
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap
      if (b.exp !== a.exp) return b.exp - a.exp
      return a.c.name.localeCompare(b.c.name, 'ja')
    })

  // 必須スキルが空の案件は”絞り”の根拠が弱いので、経験年数が多い順に上限人数へ
  if (required.length === 0) {
    return scored
      .map((x) => x.c)
      .sort((a, b) => (b.experience_years ?? -1) - (a.experience_years ?? -1) || a.name.localeCompare(b.name, 'ja'))
      .slice(0, maxCandidates)
  }

  return scored.slice(0, maxCandidates).map((x) => x.c)
}

function pickProjectsForCandidateMatch(candidate: Candidate, openProjects: Project[], mode: MatchingRunMode, maxProjects = MATCHING_DEFAULTS.fast_max_projects_per_candidate): Project[] {
  if (mode === 'full') return openProjects

  const cSkills = candidateSkillSet(candidate)
  const scored = openProjects
    .map((p) => {
      const required = (p.required_skills as string[] | undefined) ?? []
      let overlap = 0
      for (const r of required) {
        const t = normalizeSkillToken(String(r))
        if (!t) continue
        if (cSkills.has(t)) overlap += 1
      }
      return { p, overlap }
    })
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap
      return a.p.title.localeCompare(b.p.title, 'ja')
    })

  return scored.slice(0, maxProjects).map((x) => x.p)
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
  onDecide,
}: {
  s: RankedSubmission
  rankIndex: number
  onOpenCandidateDetail?: (candidateId: string) => void
  scoreColor: (score: number) => string
  onDecide?: (submission: Submission) => void
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
          {(s.candidate.drive_url || s.candidate.resume_url) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {s.candidate.drive_url && (
                <a
                  href={toViewerUrl(s.candidate.drive_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-0.5 hover:bg-blue-100 transition-colors"
                >
                  <FileText size={11} />経歴書
                </a>
              )}
              {s.candidate.resume_url && s.candidate.resume_url !== s.candidate.drive_url && (
                <a
                  href={toViewerUrl(s.candidate.resume_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-0.5 hover:bg-blue-100 transition-colors"
                >
                  <FileText size={11} />経歴書(2)
                </a>
              )}
            </div>
          )}
          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2 min-w-0">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words leading-relaxed">
              {s.ai_summary || '（理由テキストなし）'}
            </p>
          </div>
        </div>
      </div>
      <div className="shrink-0 self-stretch sm:self-start flex flex-col gap-2">
        <div
          className={`flex sm:flex-col items-center justify-center gap-1 rounded-lg px-4 py-2 sm:py-1 sm:px-3 text-center text-xl sm:text-2xl font-bold ${scoreColor(s.match_score)}`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 sm:hidden">スコア</span>
          {s.match_score}
        </div>

        {s.status === 'accepted' ? (
          <span className="inline-flex items-center justify-center gap-1 rounded-md bg-green-50 text-green-700 text-xs font-medium px-2 py-1">
            <CheckCircle size={14} />参画確定
          </span>
        ) : onDecide ? (
          <button
            type="button"
            onClick={() => onDecide(s)}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-green-600 text-white text-xs font-semibold px-2.5 py-1.5 hover:bg-green-700 active:bg-green-800 transition-colors"
            title="この人で参画確定（同一人材の他案件提案は不採用にします）"
          >
            <CheckCircle size={14} />
            この人に決定
          </button>
        ) : null}
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
  onDecide,
}: {
  s: Submission
  rankIndex: number
  p: Project | null
  onOpenProjectDetail?: (projectId: string) => void
  scoreColor: (score: number) => string
  onDecide?: (submission: Submission) => void
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
      <div className="shrink-0 self-stretch sm:self-start flex flex-col gap-2">
        <div
          className={`flex sm:flex-col items-center justify-center gap-1 rounded-lg px-4 py-2 sm:py-1 sm:px-3 text-center text-xl sm:text-2xl font-bold ${scoreColor(s.match_score)}`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 sm:hidden">スコア</span>
          {s.match_score}
        </div>

        {s.status === 'accepted' ? (
          <span className="inline-flex items-center justify-center gap-1 rounded-md bg-green-50 text-green-700 text-xs font-medium px-2 py-1">
            <CheckCircle size={14} />参画確定
          </span>
        ) : onDecide ? (
          <button
            type="button"
            onClick={() => onDecide(s)}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-green-600 text-white text-xs font-semibold px-2.5 py-1.5 hover:bg-green-700 active:bg-green-800 transition-colors"
            title="この案件で参画確定（同一人材の他案件提案は不採用にします）"
          >
            <CheckCircle size={14} />
            この案件に決定
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function MatchingPage({
  nickname,
  dataEnv,
  onOpenCandidateDetail,
  onOpenProjectDetail,
}: Props) {
  const [mode, setMode] = useState<MatchMode>('project')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'AND' | 'OR'>('AND')
  const [candidateDisplayLimit, setCandidateDisplayLimit] = useState(50)
  const [matchingRunMode, setMatchingRunMode] = useState<MatchingRunMode>(() => {
    try {
      const raw = localStorage.getItem(MATCHING_RUN_MODE_KEY)
      if (raw === 'full' || raw === 'fast') return raw
    } catch { /* ignore */ }
    return 'fast'
  })
  const { data: matchingSettings } = useQuery({
    queryKey: ['matchingSettings'],
    queryFn: getMatchingSettings,
    staleTime: 60_000,
  })
  const fastMaxCandidates = matchingSettings?.fast_max_candidates_per_project ?? MATCHING_DEFAULTS.fast_max_candidates_per_project
  const fastMaxProjects = matchingSettings?.fast_max_projects_per_candidate ?? MATCHING_DEFAULTS.fast_max_projects_per_candidate

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [matchRunProgress, setMatchRunProgress] = useState<MatchRunProgress | null>(null)
  /** 非同期ループ内でも進捗が確実に1件ずつ描画されるよう同期コミットする */
  const setMatchRunProgressNow = useCallback((next: MatchRunProgress | null) => {
    flushSync(() => {
      setMatchRunProgress(next)
    })
  }, [])
  /** 一括マッチング（全案件／全人材）のループを次の区切りで打ち切る */
  const bulkCancelRequestedRef = useRef(false)
  const queryClient = useQueryClient()

  useEffect(() => {
    try {
      localStorage.setItem(MATCHING_RUN_MODE_KEY, matchingRunMode)
    } catch { /* ignore */ }
  }, [matchingRunMode])

  const { data: projects = [] } = useQuery({
    queryKey: projectsQueryKeys.open(dataEnv),
    queryFn: () => fetchOpenProjects(dataEnv),
  })
  const { data: candidates = [], isLoading: isLoadingCandidates } = useQuery({
    queryKey: ['candidates', dataEnv],
    queryFn: () => fetchCandidates(dataEnv),
  })
  const { data: stats, isLoading: isLoadingStats } = useQuery({
    queryKey: ['submission-stats', dataEnv],
    queryFn: () => fetchSubmissionStats(dataEnv),
  })

  const projectList = projects as Project[]
  const candidateList = candidates as Candidate[]

  const filteredProjectList = useMemo(() => {
    const tokens = searchQuery.trim().toLowerCase().split(/[\s\u3000]+/).filter(Boolean)
    if (tokens.length === 0) return projectList
    return projectList.filter((p) => {
      const haystack = [
        p.title,
        p.client ?? '',
        ...((p.required_skills as string[] | undefined) ?? []),
      ].join(' ').toLowerCase()
      return searchMode === 'AND'
        ? tokens.every((t) => haystack.includes(t))
        : tokens.some((t) => haystack.includes(t))
    })
  }, [projectList, searchQuery, searchMode])

  const filteredCandidateList = useMemo(() => {
    const tokens = searchQuery.trim().toLowerCase().split(/[\s\u3000]+/).filter(Boolean)
    if (tokens.length === 0) return candidateList
    return candidateList.filter((c) => {
      const haystack = [
        c.name,
        c.email ?? '',
        ...((c.skills as string[] | undefined) ?? []),
      ].join(' ').toLowerCase()
      return searchMode === 'AND'
        ? tokens.every((t) => haystack.includes(t))
        : tokens.some((t) => haystack.includes(t))
    })
  }, [candidateList, searchQuery, searchMode])

  const { data: submissionsForSelectedProject = [], isLoading: isLoadingProjectSubs } = useQuery({
    queryKey: ['matching-submissions-for-project', dataEnv, selectedProjectId],
    queryFn: () => fetchSubmissionsByProject(selectedProjectId!, dataEnv),
    enabled: mode === 'project' && !!selectedProjectId,
  })

  const { data: submissionsForSelectedCandidate = [], isLoading: isLoadingCandidateSubs } = useQuery({
    queryKey: ['matching-submissions-for-candidate', dataEnv, selectedCandidateId],
    queryFn: () => fetchSubmissionsByCandidate(selectedCandidateId!, dataEnv),
    enabled: mode === 'candidate' && !!selectedCandidateId,
  })

  const sortedSelectedProjectSubs = useMemo(
    () => [...submissionsForSelectedProject].sort((a, b) => b.match_score - a.match_score),
    [submissionsForSelectedProject],
  )
  const sortedSelectedCandidateSubs = useMemo(
    () => [...submissionsForSelectedCandidate].sort((a, b) => b.match_score - a.match_score),
    [submissionsForSelectedCandidate],
  )

  const uniqueProjectIdsForCandidateView = useMemo(() => {
    const ids = [...new Set(sortedSelectedCandidateSubs.map((s) => s.project_id))]
    ids.sort()
    return ids
  }, [sortedSelectedCandidateSubs])
  const uniqueProjectIdsKey = uniqueProjectIdsForCandidateView.join(',')

  const { data: projectsForMatching = [], isLoading: isLoadingSupportProjects } = useQuery({
    queryKey: ['matching-support-projects', dataEnv, uniqueProjectIdsKey],
    queryFn: () => fetchProjectsByIds(uniqueProjectIdsForCandidateView, dataEnv),
    enabled: mode === 'candidate' && uniqueProjectIdsForCandidateView.length > 0,
  })

  const projectById = useMemo(
    () => new Map(projectsForMatching.map((p) => [p.id, p])),
    [projectsForMatching],
  )

  const invalidateMatchingQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['submission-stats', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
    queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all(dataEnv) })
    queryClient.invalidateQueries({ queryKey: projectsQueryKeys.open(dataEnv) })
    queryClient.invalidateQueries({ queryKey: ['matching-submissions-for-project', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['matching-submissions-for-candidate', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['matching-support-projects', dataEnv] })
  }

  const decideMutation = useMutation({
    mutationFn: async (submission: Submission) => {
      const { error: e1 } = await supabase
        .from('submissions')
        .update({ status: 'accepted' })
        .eq('id', submission.id)
        .eq('data_env', dataEnv)
      if (e1) throw new Error(e1.message)

      // 二重決定防止：同一人材の他案件提案は不採用にする
      const { error: e2 } = await supabase
        .from('submissions')
        .update({ status: 'rejected' })
        .eq('candidate_id', submission.candidate_id)
        .eq('data_env', dataEnv)
        .neq('id', submission.id)
      if (e2) throw new Error(e2.message)
    },
    onSuccess: () => {
      invalidateMatchingQueries()
      setMessage({ type: 'success', text: '参画確定にしました（同一人材の他案件は不採用に更新）' })
    },
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const matchByProjectMutation = useMutation({
    mutationFn: async (projectId: string) => {
      const project = (projects as Project[]).find((p) => p.id === projectId)
      if (!project) throw new Error('案件が見つかりません')

      const projectReq = projectToMatchRequirements(project)
      const targets = pickCandidatesForProjectMatch(project, candidates as Candidate[], matchingRunMode, fastMaxCandidates)
      const total = targets.length
      if (total === 0) return

      try {
        for (let i = 0; i < targets.length; i++) {
          const candidate = targets[i]
          setMatchRunProgressNow({
            overall: { done: i, total },
            inner: { current: i + 1, total, unit: '候補者' },
          })
          const candidateProfile = {
            name: candidate.name,
            email: candidate.email,
            phone: candidate.phone,
            skills: candidate.skills as string[],
            experienceYears: candidate.experience_years,
            summary: (candidate.raw_profile as { summary?: string }).summary ?? '',
          }
          try {
            const matchResult = await callMatchScore(candidateProfile, projectReq)

            if (matchResult.duplicateSuspected && !candidate.duplicate_flag) {
              await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', candidate.id).eq('data_env', dataEnv)
            }

            await upsertSubmission({
              candidateId: candidate.id,
              projectId,
              matchResult,
              createdBy: nickname,
              dataEnv,
            })
          } catch (err) {
            console.warn(`[match] ${candidate.name} スキップ: ${err}`)
          }
          setMatchRunProgressNow({
            overall: { done: i + 1, total },
            inner: { current: i + 1, total, unit: '候補者' },
          })
        }
      } finally {
        setMatchRunProgressNow(null)
      }
    },
    onSuccess: () => {
      invalidateMatchingQueries()
      setMessage({
        type: 'success',
        text:
          matchingRunMode === 'fast'
            ? `マッチングを更新しました（高速：最大${fastMaxCandidates}名）`
            : 'マッチングを更新しました（全件）',
      })
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

      const targetProjects = pickProjectsForCandidateMatch(candidate, projects as Project[], matchingRunMode, fastMaxProjects)
      const total = targetProjects.length
      if (total === 0) return

      try {
        for (let i = 0; i < targetProjects.length; i++) {
          const project = targetProjects[i]
          setMatchRunProgressNow({
            overall: { done: i, total },
            inner: { current: i + 1, total, unit: '案件' },
          })
          const projectReq = projectToMatchRequirements(project)
          try {
            const matchResult = await callMatchScore(candidateProfile, projectReq)

            if (matchResult.duplicateSuspected && !candidate.duplicate_flag) {
              await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', candidate.id).eq('data_env', dataEnv)
            }

            await upsertSubmission({
              candidateId: candidate.id,
              projectId: project.id,
              matchResult,
              createdBy: nickname,
              dataEnv,
            })
          } catch (err) {
            console.warn(`[match] ${project.title} スキップ: ${err}`)
          }
          setMatchRunProgressNow({
            overall: { done: i + 1, total },
            inner: { current: i + 1, total, unit: '案件' },
          })
        }
      } finally {
        setMatchRunProgressNow(null)
      }
    },
    onSuccess: () => {
      invalidateMatchingQueries()
      setMessage({
        type: 'success',
        text:
          matchingRunMode === 'fast'
            ? `マッチングを更新しました（高速：最大${fastMaxProjects}案件）`
            : 'マッチングを更新しました（この人材 × 募集中の全案件）',
      })
    },
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const bulkAllProjectsMutation = useMutation({
    mutationFn: async () => {
      bulkCancelRequestedRef.current = false
      const plist = projects as Project[]
      const clist = candidates as Candidate[]
      const total =
        matchingRunMode === 'full'
          ? plist.length * clist.length
          : plist.reduce((sum, p) => sum + pickCandidatesForProjectMatch(p, clist, 'fast', fastMaxCandidates).length, 0)
      if (total === 0) return

      let done = 0
      const projectTotal = plist.length
      setMatchRunProgressNow({ overall: { done: 0, total } })
      try {
        for (let pi = 0; pi < plist.length; pi++) {
          if (bulkCancelRequestedRef.current) {
            setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, total) })
            return
          }
          const project = plist[pi]
          const projectReq = projectToMatchRequirements(project)
          const targets = pickCandidatesForProjectMatch(project, clist, matchingRunMode, fastMaxCandidates)
          const candTotal = targets.length
          for (let ci = 0; ci < targets.length; ci++) {
            if (bulkCancelRequestedRef.current) {
              setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, total) })
              return
            }
            const candidate = targets[ci]
            setMatchRunProgressNow({
              overall: { done, total },
              outer:
                projectTotal > 1
                  ? { current: pi + 1, total: projectTotal, unit: '案件', detail: project.title }
                  : undefined,
              inner:
                candTotal > 0
                  ? { current: ci + 1, total: candTotal, unit: '候補者' }
                  : undefined,
            })
            const candidateProfile = {
              name: candidate.name,
              email: candidate.email,
              phone: candidate.phone,
              skills: candidate.skills as string[],
              experienceYears: candidate.experience_years,
              summary: (candidate.raw_profile as { summary?: string }).summary ?? '',
            }
            try {
              const matchResult = await callMatchScore(candidateProfile, projectReq)

              if (matchResult.duplicateSuspected && !candidate.duplicate_flag) {
                await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', candidate.id).eq('data_env', dataEnv)
              }

              await upsertSubmission({
                candidateId: candidate.id,
                projectId: project.id,
                matchResult,
                createdBy: nickname,
                dataEnv,
              })
            } catch (err) {
              console.warn(`[bulk-match] ${candidate.name} × ${project.title} スキップ: ${err}`)
            }
            done += 1
            setMatchRunProgressNow({
              overall: { done, total },
              outer:
                projectTotal > 1
                  ? { current: pi + 1, total: projectTotal, unit: '案件', detail: project.title }
                  : undefined,
              inner:
                candTotal > 0
                  ? { current: ci + 1, total: candTotal, unit: '候補者' }
                  : undefined,
            })
          }
        }
        setMessage({
          type: 'success',
          text:
            matchingRunMode === 'fast'
              ? `一括マッチング完了（高速モード：各案件 最大${fastMaxCandidates}名をAI評価）`
              : `一括マッチング完了（全件モード：募集中 ${plist.length} 案件 × 全 ${clist.length} 名）`,
        })
      } finally {
        bulkCancelRequestedRef.current = false
        setMatchRunProgressNow(null)
      }
    },
    onSuccess: () => invalidateMatchingQueries(),
    onError: (e) => setMessage({ type: 'error', text: String(e) }),
  })

  const bulkAllCandidatesMutation = useMutation({
    mutationFn: async () => {
      bulkCancelRequestedRef.current = false
      const plist = projects as Project[]
      const clist = candidates as Candidate[]
      const total =
        matchingRunMode === 'full'
          ? plist.length * clist.length
          : clist.reduce((sum, c) => sum + pickProjectsForCandidateMatch(c, plist, 'fast', fastMaxProjects).length, 0)
      if (total === 0) return

      let done = 0
      const peopleTotal = clist.length
      setMatchRunProgressNow({ overall: { done: 0, total } })
      try {
        for (let ci = 0; ci < clist.length; ci++) {
          if (bulkCancelRequestedRef.current) {
            setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, total) })
            return
          }
          const candidate = clist[ci]
          const candidateProfile = {
            name: candidate.name,
            email: candidate.email,
            phone: candidate.phone,
            skills: candidate.skills as string[],
            experienceYears: candidate.experience_years,
            summary: (candidate.raw_profile as { summary?: string }).summary ?? '',
          }
          const targetProjects = pickProjectsForCandidateMatch(candidate, plist, matchingRunMode, fastMaxProjects)
          const projTotal = targetProjects.length

          for (let pi = 0; pi < targetProjects.length; pi++) {
            if (bulkCancelRequestedRef.current) {
              setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, total) })
              return
            }
            const project = targetProjects[pi]
            setMatchRunProgressNow({
              overall: { done, total },
              outer:
                peopleTotal > 1
                  ? { current: ci + 1, total: peopleTotal, unit: '人材', detail: candidate.name }
                  : undefined,
              inner:
                projTotal > 0
                  ? { current: pi + 1, total: projTotal, unit: '案件' }
                  : undefined,
            })
            const projectReq = projectToMatchRequirements(project)
            try {
              const matchResult = await callMatchScore(candidateProfile, projectReq)

              if (matchResult.duplicateSuspected && !candidate.duplicate_flag) {
                await supabase.from('candidates').update({ duplicate_flag: true }).eq('id', candidate.id).eq('data_env', dataEnv)
              }

              await upsertSubmission({
                candidateId: candidate.id,
                projectId: project.id,
                matchResult,
                createdBy: nickname,
                dataEnv,
              })
            } catch (err) {
              console.warn(`[bulk-match] ${candidate.name} × ${project.title} スキップ: ${err}`)
            }
            done += 1
            setMatchRunProgressNow({
              overall: { done, total },
              outer:
                peopleTotal > 1
                  ? { current: ci + 1, total: peopleTotal, unit: '人材', detail: candidate.name }
                  : undefined,
              inner:
                projTotal > 0
                  ? { current: pi + 1, total: projTotal, unit: '案件' }
                  : undefined,
            })
          }
        }
        setMessage({
          type: 'success',
          text:
            matchingRunMode === 'fast'
              ? `一括マッチング完了（高速モード：各人材 最大${fastMaxProjects}案件をAI評価）`
              : `一括マッチング完了（全件モード：全 ${clist.length} 名 × 募集中 ${plist.length} 案件）`,
        })
      } finally {
        bulkCancelRequestedRef.current = false
        setMatchRunProgressNow(null)
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
    setSelectedProjectId(null)
    setSelectedCandidateId(null)
    setSearchQuery('')
  }

  const countByProject = stats?.countByProjectId ?? {}
  const countByCandidate = stats?.countByCandidateId ?? {}

  const selectedProject = projectList.find((p) => p.id === selectedProjectId) ?? null
  const selectedCandidate = candidateList.find((c) => c.id === selectedCandidateId) ?? null

  const selectedProjectRanked = selectedProject
    ? toRankedForProject(sortedSelectedProjectSubs, candidateList)
    : []
  const selectedCandidateSubs = sortedSelectedCandidateSubs

  const busy =
    matchByProjectMutation.isPending ||
    matchByCandidateMutation.isPending ||
    bulkAllProjectsMutation.isPending ||
    bulkAllCandidatesMutation.isPending

  const runBulkAllProjects = () => {
    const plist = projects as Project[]
    const clist = candidates as Candidate[]
    if (plist.length === 0 || clist.length === 0) return
    const maxCalls =
      matchingRunMode === 'full'
        ? plist.length * clist.length
        : plist.reduce((sum, p) => sum + pickCandidatesForProjectMatch(p, clist, 'fast', fastMaxCandidates).length, 0)
    if (
      !window.confirm(
        matchingRunMode === 'full'
          ? `募集中の全 ${plist.length} 案件について、登録済みの全 ${clist.length} 名と AI マッチングを再実行します。\nAPI 呼び出しは最大 ${maxCalls} 回です。よろしいですか？`
          : `高速モード：各案件につき「必須スキル重複が多い順」に並べ、最大 ${fastMaxCandidates} 名だけ AI マッチングします。\nAPI 呼び出しは最大 ${maxCalls} 回です（未評価の人材がいます）。よろしいですか？`,
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
    const maxCalls =
      matchingRunMode === 'full'
        ? plist.length * clist.length
        : clist.reduce((sum, c) => sum + pickProjectsForCandidateMatch(c, plist, 'fast', fastMaxProjects).length, 0)
    if (
      !window.confirm(
        matchingRunMode === 'full'
          ? `全 ${clist.length} 名の人材について、募集中の全 ${plist.length} 案件と AI マッチングを再実行します。\nAPI 呼び出しは最大 ${maxCalls} 回です。よろしいですか？`
          : `高速モード：各人材について「必須スキル重複が多い順」に並べ、最大 ${fastMaxProjects} 案件だけ AI マッチングします。\nAPI 呼び出しは最大 ${maxCalls} 回です（未評価の案件があります）。よろしいですか？`,
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
          案件ごと・人材ごとに、保存済みのスコア順ランキングと AI によるマッチング理由をその場で表示します。未実施の行は「マッチング未実施」です。
          「再実行」は、下の <span className="font-medium text-gray-700">マッチング実行モード</span>（高速/全件）に従って更新します（高速は必須スキル重複が多い候補を優先して短時間）。
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

      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-800">マッチング実行モード</p>
            <p className="text-xs text-gray-500 mt-1 break-words">
              「高速」は必須スキルとの重複が多い順に優先して、AI評価する人数（または案件数）を上限します。「全件」は登録済みの全組み合わせを評価します（時間がかかります）。
            </p>
          </div>
          <select
            value={matchingRunMode}
            onChange={(e) => {
              setMatchingRunMode(e.target.value as MatchingRunMode)
              setMessage(null)
            }}
            className="w-full sm:w-auto border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
          >
            <option value="fast">高速（おすすめ・既定）</option>
            <option value="full">全件（時間がかかる）</option>
          </select>
        </div>
        <p className="text-xs text-gray-400">
          高速モード上限：案件ごと最大 {fastMaxCandidates} 名／人材ごと最大 {fastMaxProjects} 案件（必須スキル重複が多い順）
        </p>
      </div>

      {matchRunProgress && (
        <div className="sticky top-0 z-20 text-sm text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 space-y-2 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="font-semibold text-blue-900 min-w-0">マッチング実行中…</p>
            {(bulkAllProjectsMutation.isPending || bulkAllCandidatesMutation.isPending) && (
              <button
                type="button"
                title="実行中の1件のAI評価が終わったあと、次の組み合わせに進まず停止します"
                onClick={() => {
                  bulkCancelRequestedRef.current = true
                }}
                className="shrink-0 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50"
              >
                キャンセル
              </button>
            )}
          </div>
          {(bulkAllProjectsMutation.isPending || bulkAllCandidatesMutation.isPending) && (
            <p className="text-xs text-blue-700/90">
              キャンセルは、いま処理中の1件のAI応答を待った直後に有効になります。
            </p>
          )}
          <p className="text-blue-800/95 leading-snug break-words">{formatMatchRunProgressLine(matchRunProgress)}</p>
          {matchRunProgress.overall.total > 0 && (
            <div className="h-1.5 w-full bg-blue-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-[width] duration-300 ease-out"
                style={{
                  width: `${Math.min(100, (matchRunProgress.overall.done / matchRunProgress.overall.total) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {message && (
        <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {message.text}
        </p>
      )}

      {mode === 'project' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
          <div className="px-4 py-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-800">募集中の案件</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {matchingRunMode === 'fast'
                  ? `一括：各案件 最大${fastMaxCandidates}名をAI評価`
                  : '一括：募集中の全案件 × 全人材'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={runBulkAllProjects}
                disabled={projectList.length === 0 || candidateList.length === 0 || busy}
                className="inline-flex items-center gap-1.5 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkAllProjectsMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {matchingRunMode === 'fast' ? '全案件を再マッチング（高速）' : '全案件を再マッチング（全件）'}
              </button>
              {bulkAllProjectsMutation.isPending && (
                <button
                  type="button"
                  onClick={() => { bulkCancelRequestedRef.current = true }}
                  className="inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50"
                >
                  キャンセル
                </button>
              )}
            </div>
          </div>

          {projectList.length === 0 ? (
            <p className="text-sm text-gray-400 px-4 py-8">募集中の案件がありません。</p>
          ) : (
            <div className="flex flex-col md:flex-row">
              {/* Left: project list（モバイルで詳細表示中は非表示） */}
              <div className={`w-full md:w-64 lg:w-72 shrink-0 border-b md:border-b-0 md:border-r border-gray-100 flex flex-col ${selectedProjectId ? 'hidden md:flex' : ''}`}>
                <div className="p-2 border-b border-gray-100 space-y-1.5">
                  <div className="relative">
                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => { setSearchQuery(e.target.value); setSelectedProjectId(null) }}
                      placeholder="案件名・スキルで絞り込み"
                      className="w-full pl-7 pr-2 py-1.5 text-base md:text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  </div>
                  <div className="flex gap-1">
                    {(['AND', 'OR'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setSearchMode(m)}
                        className={`px-3 py-1.5 md:px-2.5 md:py-0.5 text-xs rounded font-medium transition-colors ${searchMode === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                      >
                        {m}
                      </button>
                    ))}
                    {searchQuery && (
                      <span className="ml-auto text-xs text-gray-400 self-center">{filteredProjectList.length}件</span>
                    )}
                  </div>
                </div>
                <div className="overflow-y-auto md:max-h-[588px]">
                {filteredProjectList.length === 0 ? (
                  <p className="text-xs text-gray-400 px-3 py-4">該当する案件がありません。</p>
                ) : filteredProjectList.map((p) => {
                  const n = isLoadingStats ? null : (countByProject[p.id] ?? 0)
                  const isSelected = selectedProjectId === p.id
                  const isBusy = matchByProjectMutation.isPending && matchByProjectMutation.variables === p.id
                  return (
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedProjectId(isSelected ? null : p.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedProjectId(isSelected ? null : p.id)
                        }
                      }}
                      className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-50 last:border-0 transition-colors ${
                        isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{p.title}</div>
                        <div className="flex items-center gap-2 text-xs mt-0.5 flex-wrap">
                          {p.client && <span className="text-gray-400 truncate">{p.client}</span>}
                          {isBusy ? (
                            <span className="flex items-center gap-1 text-blue-600">
                              <Loader2 size={11} className="animate-spin" />実行中
                            </span>
                          ) : n === 0 ? (
                            <span className="text-amber-600">未実施</span>
                          ) : n !== null ? (
                            <span className="text-gray-400">{n}件のマッチング</span>
                          ) : null}
                        </div>
                      </div>
                      {isSelected && <ChevronRight size={14} className="text-blue-400 shrink-0" />}
                    </div>
                  )
                })}
                </div>
              </div>

              {/* Right: ranking panel */}
              <div className="flex-1 overflow-y-auto md:max-h-[640px]">
                {selectedProject ? (
                  <div className="p-4 space-y-4">
                    {/* モバイル用「一覧に戻る」ボタン */}
                    <button
                      type="button"
                      onClick={() => setSelectedProjectId(null)}
                      className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 md:hidden -mt-1 mb-1"
                    >
                      ← 一覧に戻る
                    </button>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-gray-800 break-words">{selectedProject.title}</h3>
                        {selectedProject.client && (
                          <p className="text-xs text-gray-500 mt-0.5">{selectedProject.client}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {onOpenProjectDetail && (
                          <button
                            type="button"
                            onClick={() => onOpenProjectDetail(selectedProject.id)}
                            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                          >
                            詳細ページ
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setMessage(null)
                            matchByProjectMutation.mutate(selectedProject.id)
                          }}
                          disabled={candidateList.length === 0 || busy}
                          className="inline-flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {matchByProjectMutation.isPending && matchByProjectMutation.variables === selectedProject.id
                            ? <Loader2 size={13} className="animate-spin" />
                            : <RefreshCw size={13} />}
                          再実行
                        </button>
                      </div>
                    </div>
                    {matchByProjectMutation.isPending && matchByProjectMutation.variables === selectedProject.id && matchRunProgress && (
                      <p className="text-xs text-blue-700 bg-blue-50 rounded px-3 py-2">
                        {formatMatchRunProgressLine(matchRunProgress)}
                      </p>
                    )}
                    {isLoadingProjectSubs || isLoadingCandidates ? (
                      <p className="text-sm text-gray-400">読み込み中...</p>
                    ) : selectedProjectRanked.length === 0 ? (
                      <p className="text-sm text-gray-500">マッチング未実施、または「再実行」で算出してください。</p>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-medium text-gray-500">
                          マッチングランキング（全 {selectedProjectRanked.length} 名）— スコアと理由は AI 判定です
                        </p>
                        <div className="space-y-3">
                          {selectedProjectRanked.slice(0, RANK_HEAD).map((s, i) => (
                            <ProjectModeRankCard
                              key={s.id}
                              s={s}
                              rankIndex={i}
                              onOpenCandidateDetail={onOpenCandidateDetail}
                              scoreColor={scoreColor}
                              onDecide={(sub) => decideMutation.mutate(sub)}
                            />
                          ))}
                          <RankingRestAccordion count={selectedProjectRanked.length - RANK_HEAD} unitLabel="名">
                            {selectedProjectRanked.slice(RANK_HEAD).map((s, idx) => (
                              <ProjectModeRankCard
                                key={s.id}
                                s={s}
                                rankIndex={RANK_HEAD + idx}
                                onOpenCandidateDetail={onOpenCandidateDetail}
                                scoreColor={scoreColor}
                                onDecide={(sub) => decideMutation.mutate(sub)}
                              />
                            ))}
                          </RankingRestAccordion>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-32 md:h-full text-sm text-gray-400 p-8 text-center">
                    ← 案件を選択するとマッチングランキングが表示されます
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'candidate' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
          <div className="px-4 py-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-800">登録人材</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {matchingRunMode === 'fast'
                  ? `一括：各人材 最大${fastMaxProjects}案件をAI評価`
                  : '一括：全人材 × 募集中の全案件'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={runBulkAllCandidates}
                disabled={projectList.length === 0 || candidateList.length === 0 || busy}
                className="inline-flex items-center gap-1.5 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkAllCandidatesMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {matchingRunMode === 'fast' ? '全人材を再マッチング（高速）' : '全人材を再マッチング（全件）'}
              </button>
              {bulkAllCandidatesMutation.isPending && (
                <button
                  type="button"
                  onClick={() => { bulkCancelRequestedRef.current = true }}
                  className="inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50"
                >
                  キャンセル
                </button>
              )}
            </div>
          </div>

          {candidateList.length === 0 ? (
            <p className="text-sm text-gray-400 px-4 py-8">登録人材がありません。</p>
          ) : (
            <div className="flex flex-col md:flex-row">
              {/* Left: candidate list（モバイルで詳細表示中は非表示） */}
              <div className={`w-full md:w-64 lg:w-72 shrink-0 border-b md:border-b-0 md:border-r border-gray-100 flex flex-col ${selectedCandidateId ? 'hidden md:flex' : ''}`}>
                <div className="p-2 border-b border-gray-100 space-y-1.5">
                  <div className="relative">
                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => { setSearchQuery(e.target.value); setSelectedCandidateId(null); setCandidateDisplayLimit(50) }}
                      placeholder="氏名・スキルで絞り込み"
                      className="w-full pl-7 pr-2 py-1.5 text-base md:text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  </div>
                  <div className="flex gap-1">
                    {(['AND', 'OR'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setSearchMode(m)}
                        className={`px-3 py-1.5 md:px-2.5 md:py-0.5 text-xs rounded font-medium transition-colors ${searchMode === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                      >
                        {m}
                      </button>
                    ))}
                    {searchQuery && (
                      <span className="ml-auto text-xs text-gray-400 self-center">{filteredCandidateList.length}件</span>
                    )}
                  </div>
                </div>
                <div className="overflow-y-auto md:max-h-[588px]">
                {filteredCandidateList.length === 0 ? (
                  <p className="text-xs text-gray-400 px-3 py-4">該当する人材がありません。</p>
                ) : filteredCandidateList.slice(0, candidateDisplayLimit).map((c) => {
                  const n = isLoadingStats ? null : (countByCandidate[c.id] ?? 0)
                  const isSelected = selectedCandidateId === c.id
                  const isBusy = matchByCandidateMutation.isPending && matchByCandidateMutation.variables === c.id
                  return (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedCandidateId(isSelected ? null : c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedCandidateId(isSelected ? null : c.id)
                        }
                      }}
                      className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-50 last:border-0 transition-colors ${
                        isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{c.name}</div>
                        <div className="flex items-center gap-2 text-xs mt-0.5">
                          {c.email && <span className="text-gray-400 truncate">{c.email}</span>}
                          {isBusy ? (
                            <span className="flex items-center gap-1 text-blue-600">
                              <Loader2 size={11} className="animate-spin" />実行中
                            </span>
                          ) : n === 0 ? (
                            <span className="text-amber-600">未実施</span>
                          ) : n !== null ? (
                            <span className="text-gray-400">{n}件のマッチング</span>
                          ) : null}
                        </div>
                      </div>
                      {isSelected && <ChevronRight size={14} className="text-blue-400 shrink-0" />}
                    </div>
                  )
                })}
                {filteredCandidateList.length > candidateDisplayLimit && (
                  <button
                    type="button"
                    onClick={() => setCandidateDisplayLimit(n => n + 50)}
                    className="w-full py-2 text-xs text-blue-600 hover:bg-blue-50 border-t border-gray-100"
                  >
                    もっと見る（残り{filteredCandidateList.length - candidateDisplayLimit}件）
                  </button>
                )}
                </div>
              </div>

              {/* Right: ranking panel */}
              <div className="flex-1 overflow-y-auto md:max-h-[640px]">
                {selectedCandidate ? (
                  <div className="p-4 space-y-4">
                    {/* モバイル用「一覧に戻る」ボタン */}
                    <button
                      type="button"
                      onClick={() => setSelectedCandidateId(null)}
                      className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 md:hidden -mt-1 mb-1"
                    >
                      ← 一覧に戻る
                    </button>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-gray-800 break-words">{selectedCandidate.name}</h3>
                        {selectedCandidate.email && (
                          <p className="text-xs text-gray-500 mt-0.5 break-all">{selectedCandidate.email}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {onOpenCandidateDetail && (
                          <button
                            type="button"
                            onClick={() => onOpenCandidateDetail(selectedCandidate.id)}
                            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                          >
                            詳細ページ
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setMessage(null)
                            matchByCandidateMutation.mutate(selectedCandidate.id)
                          }}
                          disabled={projectList.length === 0 || busy}
                          className="inline-flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {matchByCandidateMutation.isPending && matchByCandidateMutation.variables === selectedCandidate.id
                            ? <Loader2 size={13} className="animate-spin" />
                            : <RefreshCw size={13} />}
                          再実行
                        </button>
                      </div>
                    </div>
                    {matchByCandidateMutation.isPending && matchByCandidateMutation.variables === selectedCandidate.id && matchRunProgress && (
                      <p className="text-xs text-blue-700 bg-blue-50 rounded px-3 py-2">
                        {formatMatchRunProgressLine(matchRunProgress)}
                      </p>
                    )}
                    {isLoadingCandidateSubs || isLoadingSupportProjects || isLoadingCandidates ? (
                      <p className="text-sm text-gray-400">読み込み中...</p>
                    ) : selectedCandidateSubs.length === 0 ? (
                      <p className="text-sm text-gray-500">マッチング未実施、または「再実行」で算出してください。</p>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-medium text-gray-500">
                          おすすめ案件（スコア順・全 {selectedCandidateSubs.length} 件）— スコアと理由は AI 判定です
                        </p>
                        <div className="space-y-3">
                          {selectedCandidateSubs.slice(0, RANK_HEAD).map((s, i) => {
                            const p = projectById.get(s.project_id) ?? null
                            return (
                              <CandidateModeRankCard
                                key={s.id}
                                s={s}
                                rankIndex={i}
                                p={p}
                                onOpenProjectDetail={onOpenProjectDetail}
                                scoreColor={scoreColor}
                                onDecide={(sub) => decideMutation.mutate(sub)}
                              />
                            )
                          })}
                          <RankingRestAccordion count={selectedCandidateSubs.length - RANK_HEAD} unitLabel="件">
                            {selectedCandidateSubs.slice(RANK_HEAD).map((s, idx) => {
                              const p = projectById.get(s.project_id) ?? null
                              return (
                                <CandidateModeRankCard
                                  key={s.id}
                                  s={s}
                                  rankIndex={RANK_HEAD + idx}
                                  p={p}
                                  onOpenProjectDetail={onOpenProjectDetail}
                                  scoreColor={scoreColor}
                                  onDecide={(sub) => decideMutation.mutate(sub)}
                                />
                              )
                            })}
                          </RankingRestAccordion>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-32 md:h-full text-sm text-gray-400 p-8 text-center">
                    ← 人材を選択するとおすすめ案件のランキングが表示されます
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
