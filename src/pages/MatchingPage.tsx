import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertTriangle, Briefcase, User, RefreshCw, ChevronDown, CheckCircle, ChevronRight, Search, FileText, Mail, SlidersHorizontal, RotateCcw } from 'lucide-react'
import { toViewerUrl } from '../lib/viewerUrl'
import { fetchCandidatesForMatching, fetchCandidatesForProject, findDuplicateCandidates, DEFAULT_SCORING_WEIGHTS } from '../lib/db/candidates'
import type { ScoringWeights } from '../lib/db/candidates'
import { logError } from '../lib/errorLog'
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
import type { Candidate, DuplicateCandidate } from '../lib/db/candidates'
import type { Project } from '../lib/db/projects'
import type { Submission } from '../lib/db/submissions'
import type { DataEnv } from '../lib/dataEnv'

interface BatchMatchResult {
  candidateId: string
  projectId?: string
  score: number
  summary: string
  method: 'ai' | 'rule'
  ruleScore: number
}

/** バッチマッチング：1回のAI呼び出しで複数候補者/案件を一括評価 */
async function callMatchBatch(
  mode: 'project_to_candidates' | 'candidate_to_projects',
  payload: Record<string, unknown>,
  topN: number,
): Promise<{ results: BatchMatchResult[]; ruleOnly: BatchMatchResult[] }> {
  const { data, error } = await supabase.functions.invoke('match-batch', {
    body: { mode, ...payload, topN },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as { results: BatchMatchResult[]; ruleOnly: BatchMatchResult[] }
}

/** 案件→複数候補者のバッチマッチング（全件モード時はBATCH_SIZEごとに分割） */
const BATCH_AI_SIZE = 20   // candidate_to_projects のチャンクサイズ（案件数が多い場合のみ使用）
const BATCH_TOP_N = 10    // 全候補者の中から AI 採点するグローバル上位件数

type CandidateBatchInput = {
  id: string
  name: string
  skills: string[]
  experienceYears: number | null
  desiredRate: string | null
  summary: string
  remoteAvailable?: boolean | null
  wantsFullRemote?: boolean | null
  prefecture?: string | null
  availableRegions?: string[] | null
  preferredJobTypes?: string[] | null
  agentComment?: string | null
  nationality?: string | null
  selfPR?: string | null
  skillYears?: Record<string, number> | null
  desiredProject?: string | null
}

function toCandidateBatchInput(c: Candidate): CandidateBatchInput {
  const rp = c.raw_profile as Record<string, unknown>
  return {
    id: c.id,
    name: c.name,
    skills: c.skills as string[],
    experienceYears: c.experience_years,
    desiredRate: c.desired_rate ?? (rp?.desiredRate as string | null) ?? null,
    summary: typeof rp?.summary === 'string' ? rp.summary : '',
    remoteAvailable: (rp?.remoteAvailable as boolean | null) ?? null,
    wantsFullRemote: (rp?.wantsFullRemote as boolean | null) ?? null,
    prefecture: (rp?.prefecture as string | null) ?? null,
    availableRegions: Array.isArray(rp?.availableRegions) ? (rp.availableRegions as string[]) : null,
    preferredJobTypes: Array.isArray(rp?.roles) ? (rp.roles as string[]) : null,
    agentComment: (rp?.agentComment as string | null) ?? null,
    nationality: (rp?.nationality as string | null) ?? null,
    selfPR: (rp?.selfPR as string | null) ?? null,
    skillYears: (rp?.skillYears as Record<string, number> | null) ?? null,
    desiredProject: (rp?.desiredProject as string | null) ?? null,
  }
}

async function matchBatchProjectToCandidates(
  projectReq: unknown,
  targets: Candidate[],
  onProgress: (done: number, total: number) => void,
  weights?: ScoringWeights,
): Promise<Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }>> {
  const resultMap = new Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }>()

  // SQL 側でスコア順・日付順ソート済み。上位 BATCH_TOP_N 人だけ AI 採点。
  const aiTargets = targets.slice(0, BATCH_TOP_N)
  const ruleOnlyRest = targets.slice(BATCH_TOP_N)

  onProgress(0, targets.length)
  const { results } = await callMatchBatch('project_to_candidates', {
    projectRequirements: projectReq,
    candidates: aiTargets.map(toCandidateBatchInput),
    weights,
  }, BATCH_TOP_N)
  onProgress(targets.length, targets.length)

  const aiMap = new Map(results.map(r => [r.candidateId, r]))

  for (const c of aiTargets) {
    const ai = aiMap.get(c.id)
    const ruleScore = ai?.ruleScore ?? 0
    resultMap.set(c.id, {
      score: ai?.score ?? ruleScore,
      summary: ai?.summary ?? '',
      breakdown: (ai as { breakdown?: string } | undefined)?.breakdown ?? '',
      ruleScore,
    })
  }

  // ruleOnlyRest: ルールスコアのみ（AI 不使用・topN=0 で全員 ruleOnly 扱い）
  for (let i = 0; i < ruleOnlyRest.length; i += BATCH_AI_SIZE) {
    const chunk = ruleOnlyRest.slice(i, i + BATCH_AI_SIZE)
    try {
      const { ruleOnly } = await callMatchBatch('project_to_candidates', {
        projectRequirements: projectReq,
        candidates: chunk.map(toCandidateBatchInput),
        weights,
      }, 0)
      const ruleMap = new Map(ruleOnly.map(r => [r.candidateId, r]))
      for (const c of chunk) {
        const r = ruleMap.get(c.id)
        resultMap.set(c.id, {
          score: r?.ruleScore ?? 0,
          summary: '',
          breakdown: (r as { breakdown?: string } | undefined)?.breakdown ?? '',
          ruleScore: r?.ruleScore ?? 0,
        })
      }
    } catch {
      for (const c of chunk) {
        resultMap.set(c.id, { score: 0, summary: '', breakdown: '', ruleScore: 0 })
      }
    }
  }

  return resultMap
}

async function matchBatchCandidateToProjects(
  candidateInput: CandidateBatchInput,
  targetProjects: Project[],
  onProgress: (done: number, total: number) => void,
  weights?: ScoringWeights,
): Promise<Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }>> {
  const resultMap = new Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }>()
  const projectInputs = targetProjects.map(p => ({
    id: p.id,
    title: p.title,
    requiredSkills: p.required_skills as string[],
    niceToHaveSkills: (p.raw_data?.niceToHaveSkills as string[] | undefined) ?? [],
    budgetMin: p.budget_min ?? null,
    budgetMax: p.budget_max ?? null,
    workLocation: p.work_location ?? null,
    remotePolicy: p.remote_policy ?? null,
    description: p.description ?? null,
    roleSummary: p.role_summary ?? null,
  }))
  let done = 0
  const total = targetProjects.length

  for (let i = 0; i < projectInputs.length; i += BATCH_AI_SIZE) {
    const chunk = projectInputs.slice(i, i + BATCH_AI_SIZE)
    const { results, ruleOnly } = await callMatchBatch('candidate_to_projects', {
      candidateProfile: candidateInput,
      projects: chunk,
      weights,
    }, Math.min(BATCH_TOP_N, chunk.length))
    for (const r of [...results, ...ruleOnly]) {
      if (r.projectId) resultMap.set(r.projectId, { score: r.score, summary: r.summary, breakdown: (r as { breakdown?: string }).breakdown ?? '', ruleScore: r.ruleScore })
    }
    done = Math.min(i + BATCH_AI_SIZE, total)
    onProgress(done, total)
  }
  return resultMap
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

/** 同一人物スコアを計算する（名前一致はDB側で保証済み→+50固定）
 * -1 を返した場合は「明らかに別人」として表示から除外する */
function calcDuplicateScore(dup: Omit<DuplicateCandidate, 'duplicateScore'>, ref: Candidate): number {
  const dupStation = (dup.raw_profile?.nearestStation as string | undefined) ?? ''
  const refStation = (ref.raw_profile?.nearestStation as string | undefined) ?? ''
  const dupPref = (dup.raw_profile?.prefecture as string | undefined) ?? ''
  const refPref = (ref.raw_profile?.prefecture as string | undefined) ?? ''

  // 最寄り駅が両方存在して異なる → 別人（除外）
  if (dupStation && refStation && dupStation !== refStation) return -1

  // 都道府県が両方存在して異なる → 別人（除外）
  if (dupPref && refPref && dupPref !== refPref) return -1

  // 経験年数の差が5年以上 → 別人（除外）
  if (dup.experience_years != null && ref.experience_years != null &&
      Math.abs(dup.experience_years - ref.experience_years) >= 5) return -1

  let score = 50 // 名前一致はRPCで保証済み

  // 最寄り駅一致 (+30)
  if (dupStation && refStation && dupStation === refStation) score += 30

  // メール一致 (+50)
  if (dup.email && ref.email && dup.email.toLowerCase() === ref.email.toLowerCase()) score += 50

  // スキル一致率 ≥ 50% (+10)
  const dupSkills = (dup.skills ?? []).map(s => s.toLowerCase())
  const refSkills = (ref.skills ?? []).map(s => s.toLowerCase())
  if (dupSkills.length > 0 && refSkills.length > 0) {
    const common = dupSkills.filter(s => refSkills.includes(s)).length
    if (common / Math.min(dupSkills.length, refSkills.length) >= 0.5) score += 10
  }

  // 経験年数 ±1年以内 (+10)
  if (dup.experience_years != null && ref.experience_years != null &&
      Math.abs(dup.experience_years - ref.experience_years) <= 1) score += 10

  return score
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

function SkillTagsWithAccordion({ skills, highlightSkills = [] }: { skills: string[], highlightSkills?: string[] }) {
  if (skills.length === 0) return null
  const hlSet = new Set(highlightSkills.map(s => s.toLowerCase()))
  const tagCls = (sk: string) =>
    hlSet.size > 0 && hlSet.has(sk.toLowerCase())
      ? 'text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5 font-medium'
      : 'text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5'
  if (skills.length <= SKILL_HEAD) {
    return (
      <div className="flex flex-wrap gap-1 mt-1">
        {skills.map((sk) => (
          <span key={sk} className={tagCls(sk)}>
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
          <span key={sk} className={tagCls(sk)}>
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
            <span key={sk} className={tagCls(sk)}>
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
  duplicates,
  requiredSkills = [],
}: {
  s: RankedSubmission
  rankIndex: number
  onOpenCandidateDetail?: (candidateId: string) => void
  scoreColor: (score: number) => string
  onDecide?: (submission: Submission) => void
  duplicates?: DuplicateCandidate[]
  requiredSkills?: string[]
}) {
  const [showEmail, setShowEmail] = useState(false)
  const rawText = (s.candidate.raw_profile as Record<string, unknown>)?.text as string | undefined
  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden bg-white min-w-0">
    <div className="p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
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
          {(() => {
            const allSkills = (s.candidate.skills as string[]) ?? []
            const reqLower = requiredSkills.map(r => r.toLowerCase())
            const matched = allSkills.filter(sk => reqLower.some(r => sk.toLowerCase().includes(r) || r.includes(sk.toLowerCase())))
            const unmatched = allSkills.filter(sk => !reqLower.some(r => sk.toLowerCase().includes(r) || r.includes(sk.toLowerCase())))
            return <SkillTagsWithAccordion skills={[...matched, ...unmatched]} highlightSkills={matched} />
          })()}
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
                  <FileText size={11} />{s.candidate.drive_url ? '経歴書(2)' : '経歴書'}
                </a>
              )}
            </div>
          )}
          {(() => {
            const rp = s.candidate.raw_profile as Record<string, unknown>
            const from = rp?.from as string | null
            const receivedAt = rp?.emailReceivedAt as string | null
            if (!from && !receivedAt) return null
            return (
              <p className="text-[10px] text-gray-400 mt-1">
                {from && <span>{from}</span>}
                {from && receivedAt && <span className="mx-1">／</span>}
                {receivedAt && <span>{new Date(receivedAt).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
              </p>
            )
          })()}
          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2 min-w-0">
            {s.ai_summary ? (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words leading-relaxed">{s.ai_summary}</p>
              </>
            ) : (s.ai_raw as Record<string, unknown>)?.breakdown ? (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">スコア内訳（ルールベース）</p>
                <p className="text-xs text-gray-600 mt-1 break-words leading-relaxed font-mono">{String((s.ai_raw as Record<string, unknown>).breakdown)}</p>
              </>
            ) : (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-400 mt-1">（理由テキストなし）</p>
              </>
            )}
          </div>
          {rawText && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => setShowEmail(v => !v)}
                className="inline-flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
              >
                <Mail size={10} />
                {showEmail ? '元メールを閉じる' : '元メールを見る'}
                <ChevronDown size={10} className={`transition-transform ${showEmail ? 'rotate-180' : ''}`} />
              </button>
              {showEmail && (
                <pre className="mt-1 text-[10px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-y-auto">
                  {rawText}
                </pre>
              )}
            </div>
          )}
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
    {duplicates && duplicates.length > 0 && (() => {
      // 同一内容の重複を除去（以下のいずれかに該当すれば同一人物扱い）
      // 1. 差出人+件名が同じ（確実に同一メール）
      // 2. 同じ差出人メールアドレスから来た同名人材（別日・別件名でも同一エージェント再送）
      // 3. 名前+会社+単価が同じ
      const seenKeys = new Set<string>()
      // メインカード自体の差出人・件名・送信者を先に登録して、同じものは除外する
      const mainRp = s.candidate.raw_profile as Record<string, unknown>
      const mainFrom = mainRp?.from as string | undefined
      const mainSubject = mainRp?.subject as string | undefined
      if (mainFrom && mainSubject) seenKeys.add(`mail:${mainFrom}|${mainSubject}`)
      if (mainFrom) seenKeys.add(`sender:${mainFrom}`)
      const deduped = duplicates.filter(d => {
        const fromAddr = d.raw_profile?.from as string | undefined
        const subjectStr = d.raw_profile?.subject as string | undefined
        // 1. 差出人+件名が同じ
        const mailKey = fromAddr && subjectStr ? `mail:${fromAddr}|${subjectStr}` : null
        if (mailKey && seenKeys.has(mailKey)) return false
        // 2. 同じ差出人からの同名（日付・件名問わず）
        const senderKey = fromAddr ? `sender:${fromAddr}` : null
        if (senderKey && seenKeys.has(senderKey)) return false
        // 3. 名前+会社+単価
        const infoKey = `info:${d.name}|${d.from_company ?? ''}|${d.desired_rate ?? ''}`
        if (seenKeys.has(infoKey)) return false
        if (mailKey) seenKeys.add(mailKey)
        if (senderKey) seenKeys.add(senderKey)
        seenKeys.add(infoKey)
        return true
      })
      return (
        <div className="border-t border-amber-100 bg-amber-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide mb-1.5">
            別ルートの同一人物候補（{deduped.length}件）
          </p>
          <div className="space-y-1.5">
            {deduped.map(d => {
              const fromAddr = d.raw_profile?.from as string | undefined
              const subjectStr = d.raw_profile?.subject as string | undefined
              const receivedAt = d.raw_profile?.emailReceivedAt as string | undefined
              const receivedLabel = receivedAt
                ? new Date(receivedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : null
              return (
                <div key={d.id} className="flex flex-col gap-0.5 text-xs bg-white rounded px-2.5 py-1.5 border border-amber-200">
                  <div className="flex flex-wrap items-center gap-x-2">
                    {onOpenCandidateDetail ? (
                      <button
                        type="button"
                        onClick={() => onOpenCandidateDetail(d.id)}
                        className="font-medium text-gray-800 hover:text-blue-700 hover:underline"
                      >
                        {d.name}
                      </button>
                    ) : (
                      <span className="font-medium text-gray-800">{d.name}</span>
                    )}
                    {d.from_company && <span className="text-amber-700">{d.from_company}</span>}
                    {d.desired_rate && <span className="text-green-700 font-medium">{d.desired_rate}</span>}
                    {d.experience_years != null && <span className="text-gray-500">経験{d.experience_years}年</span>}
                    <span className="ml-auto text-[10px] text-amber-500">同一スコア {d.duplicateScore}</span>
                  </div>
                  {(fromAddr || subjectStr || receivedLabel) && (
                    <div className="flex flex-wrap gap-x-2 gap-y-0 text-[10px] text-gray-400">
                      {receivedLabel && <span>{receivedLabel}</span>}
                      {fromAddr && <span className="truncate max-w-[200px]" title={fromAddr}>{fromAddr}</span>}
                      {subjectStr && <span className="truncate max-w-[240px] text-gray-500" title={subjectStr}>「{subjectStr}」</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )
    })()}
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
            {s.ai_summary ? (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words leading-relaxed">{s.ai_summary}</p>
              </>
            ) : (s.ai_raw as Record<string, unknown>)?.breakdown ? (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">スコア内訳（ルールベース）</p>
                <p className="text-xs text-gray-600 mt-1 break-words leading-relaxed font-mono">{String((s.ai_raw as Record<string, unknown>).breakdown)}</p>
              </>
            ) : (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-400 mt-1">（理由テキストなし）</p>
              </>
            )}
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
  const [scoringWeights, setScoringWeights] = useState<ScoringWeights>({ ...DEFAULT_SCORING_WEIGHTS })
  const [showWeightsPanel, setShowWeightsPanel] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'AND' | 'OR'>('AND')
  const [candidateDisplayLimit, setCandidateDisplayLimit] = useState(50)
  const { data: matchingSettings } = useQuery({
    queryKey: ['matchingSettings'],
    queryFn: getMatchingSettings,
    staleTime: 60_000,
  })
  const matchingRunMode: MatchingRunMode = matchingSettings?.run_mode ?? 'fast'
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

const { data: projects = [] } = useQuery({
    queryKey: projectsQueryKeys.open(dataEnv),
    queryFn: () => fetchOpenProjects(dataEnv),
  })
  const { data: candidates = [], isLoading: isLoadingCandidates } = useQuery({
    queryKey: ['candidates', dataEnv],
    queryFn: () => fetchCandidatesForMatching(dataEnv),
  })
  const { data: stats, isLoading: isLoadingStats } = useQuery({
    queryKey: ['submission-stats', dataEnv],
    queryFn: () => fetchSubmissionStats(dataEnv),
  })

  const projectList = projects as Project[]
  // duplicate_flag / merged_into のフィルターは RPC 側（fetch_candidates_for_matching）で実施済み
  const candidateList = useMemo(
    () => candidates as Candidate[],
    [candidates],
  )

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
    onError: (e) => { logError(e, 'MatchingPage', undefined, { dataEnv, nickname }); setMessage({ type: 'error', text: String(e) }) },
  })

  const matchByProjectMutation = useMutation({
    mutationFn: async (projectId: string) => {
      const project = (projects as Project[]).find((p) => p.id === projectId)
      if (!project) throw new Error('案件が見つかりません')

      const projectReq = projectToMatchRequirements(project)
      // fast: SQL で上位 fastMaxCandidates 件を取得。先頭 BATCH_TOP_N だけ AI 採点、残りはルールスコアのみ
      // full: SQL で上位 500 件を取得し、match-batch 内で先頭 BATCH_TOP_N だけ AI 採点
      const sqlLimit = matchingRunMode === 'fast' ? fastMaxCandidates : 500
      const targets = await fetchCandidatesForProject(
        { requiredSkills: project.required_skills as string[], budgetMin: project.budget_min, budgetMax: project.budget_max, workLocation: project.work_location, remotePolicy: project.remote_policy, weights: scoringWeights },
        dataEnv,
        sqlLimit,
      )
      const total = targets.length
      if (total === 0) return

      try {
        setMatchRunProgressNow({ overall: { done: 0, total }, inner: { current: 0, total, unit: '候補者' } })

        const resultMap = await matchBatchProjectToCandidates(
          projectReq,
          targets,
          (done, t) => setMatchRunProgressNow({ overall: { done, total: t }, inner: { current: done, total: t, unit: '候補者' } }),
          scoringWeights,
        )

        for (const candidate of targets) {
          const r = resultMap.get(candidate.id)
          if (!r) continue
          try {
            await upsertSubmission({
              candidateId: candidate.id,
              projectId,
              matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
              breakdown: r.breakdown,
              createdBy: nickname,
              dataEnv,
            })
          } catch (err) {
            console.warn(`[match] ${candidate.name} スキップ: ${err}`)
          }
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
    onError: (e) => { logError(e, 'MatchingPage', undefined, { dataEnv, nickname }); setMessage({ type: 'error', text: String(e) }) },
  })

  const matchByCandidateMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const candidate = (candidates as Candidate[]).find((c) => c.id === candidateId)
      if (!candidate) throw new Error('人材が見つかりません')
      if ((projects as Project[]).length === 0) throw new Error('募集中の案件がありません')

      const targetProjects = pickProjectsForCandidateMatch(candidate, projects as Project[], matchingRunMode, fastMaxProjects)
      const total = targetProjects.length
      if (total === 0) return

      try {
        setMatchRunProgressNow({ overall: { done: 0, total }, inner: { current: 0, total, unit: '案件' } })

        const candidateInput = toCandidateBatchInput(candidate)
        const resultMap = await matchBatchCandidateToProjects(
          candidateInput,
          targetProjects,
          (done, t) => setMatchRunProgressNow({ overall: { done, total: t }, inner: { current: done, total: t, unit: '案件' } }),
          scoringWeights,
        )

        for (const project of targetProjects) {
          const r = resultMap.get(project.id)
          if (!r) continue
          try {
            await upsertSubmission({
              candidateId: candidate.id,
              projectId: project.id,
              matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
              breakdown: r.breakdown,
              createdBy: nickname,
              dataEnv,
            })
          } catch (err) {
            console.warn(`[match] ${project.title} スキップ: ${err}`)
          }
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
    onError: (e) => { logError(e, 'MatchingPage', undefined, { dataEnv, nickname }); setMessage({ type: 'error', text: String(e) }) },
  })

  const bulkAllProjectsMutation = useMutation({
    mutationFn: async () => {
      bulkCancelRequestedRef.current = false
      const plist = projects as Project[]
      if (plist.length === 0) return

      let done = 0
      const projectTotal = plist.length
      // SQL絞り込みを使うため総候補者数は事前不明 → 案件数ベースで進捗表示
      setMatchRunProgressNow({ overall: { done: 0, total: projectTotal } })
      try {
        for (let pi = 0; pi < plist.length; pi++) {
          if (bulkCancelRequestedRef.current) {
            setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, projectTotal) })
            return
          }
          const project = plist[pi]
          const projectReq = projectToMatchRequirements(project)
          // fast: SQL で上位 BATCH_TOP_N 件のみ取得してそのまま全件 AI 採点
          const sqlLimit2 = matchingRunMode === 'fast' ? BATCH_TOP_N : 500
          const targets = await fetchCandidatesForProject(
            { requiredSkills: project.required_skills as string[], budgetMin: project.budget_min, budgetMax: project.budget_max, workLocation: project.work_location, remotePolicy: project.remote_policy, weights: scoringWeights },
            dataEnv,
            sqlLimit2,
          )
          const candTotal = targets.length

          setMatchRunProgressNow({
            overall: { done, total: projectTotal },
            outer: projectTotal > 1 ? { current: pi + 1, total: projectTotal, unit: '案件', detail: project.title } : undefined,
            inner: candTotal > 0 ? { current: 0, total: candTotal, unit: '候補者' } : undefined,
          })

          let resultMap: Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }> = new Map()
          try {
            resultMap = await matchBatchProjectToCandidates(
              projectReq,
              targets,
              (batchDone, batchTotal) => {
                setMatchRunProgressNow({
                  overall: { done, total: projectTotal },
                  outer: projectTotal > 1 ? { current: pi + 1, total: projectTotal, unit: '案件', detail: project.title } : undefined,
                  inner: batchTotal > 0 ? { current: batchDone, total: batchTotal, unit: '候補者' } : undefined,
                })
              },
              scoringWeights,
            )
          } catch (err) {
            console.warn(`[bulk-match] ${project.title} バッチ失敗: ${err}`)
          }

          for (const candidate of targets) {
            if (bulkCancelRequestedRef.current) {
              setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, projectTotal) })
              return
            }
            const r = resultMap.get(candidate.id)
            if (r) {
              try {
                await upsertSubmission({
                  candidateId: candidate.id,
                  projectId: project.id,
                  matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
              breakdown: r.breakdown,
                  createdBy: nickname,
                  dataEnv,
                })
              } catch (err) {
                console.warn(`[bulk-match] ${candidate.name} × ${project.title} スキップ: ${err}`)
              }
            }
            done += 1
          }
        }
        setMessage({
          type: 'success',
          text:
            matchingRunMode === 'fast'
              ? `一括マッチング完了（高速モード：各案件 最大${fastMaxCandidates}名をAI評価）`
              : `一括マッチング完了（全件モード：募集中 ${plist.length} 案件）`,
        })
      } finally {
        bulkCancelRequestedRef.current = false
        setMatchRunProgressNow(null)
      }
    },
    onSuccess: () => invalidateMatchingQueries(),
    onError: (e) => { logError(e, 'MatchingPage', undefined, { dataEnv, nickname }); setMessage({ type: 'error', text: String(e) }) },
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
          const targetProjects = pickProjectsForCandidateMatch(candidate, plist, matchingRunMode, fastMaxProjects)
          const projTotal = targetProjects.length

          setMatchRunProgressNow({
            overall: { done, total },
            outer: peopleTotal > 1 ? { current: ci + 1, total: peopleTotal, unit: '人材', detail: candidate.name } : undefined,
            inner: projTotal > 0 ? { current: 0, total: projTotal, unit: '案件' } : undefined,
          })

          const candidateInput = toCandidateBatchInput(candidate)
          let resultMap: Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }> = new Map()
          try {
            resultMap = await matchBatchCandidateToProjects(
              candidateInput,
              targetProjects,
              (batchDone, batchTotal) => {
                setMatchRunProgressNow({
                  overall: { done, total },
                  outer: peopleTotal > 1 ? { current: ci + 1, total: peopleTotal, unit: '人材', detail: candidate.name } : undefined,
                  inner: batchTotal > 0 ? { current: batchDone, total: batchTotal, unit: '案件' } : undefined,
                })
              },
              scoringWeights,
            )
          } catch (err) {
            console.warn(`[bulk-match] ${candidate.name} バッチ失敗: ${err}`)
          }

          for (const project of targetProjects) {
            if (bulkCancelRequestedRef.current) {
              setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, total) })
              return
            }
            const r = resultMap.get(project.id)
            if (r) {
              try {
                await upsertSubmission({
                  candidateId: candidate.id,
                  projectId: project.id,
                  matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
              breakdown: r.breakdown,
                  createdBy: nickname,
                  dataEnv,
                })
              } catch (err) {
                console.warn(`[bulk-match] ${candidate.name} × ${project.title} スキップ: ${err}`)
              }
            }
            done += 1
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
    onError: (e) => { logError(e, 'MatchingPage', undefined, { dataEnv, nickname }); setMessage({ type: 'error', text: String(e) }) },
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

  // 重複候補マップ: candidate_id → DuplicateCandidate[]
  const [duplicatesMap, setDuplicatesMap] = useState<Record<string, DuplicateCandidate[]>>({})
  useEffect(() => {
    if (mode !== 'project' || !selectedProjectId || selectedProjectRanked.length === 0) {
      setDuplicatesMap({})
      return
    }
    let cancelled = false
    Promise.all(
      selectedProjectRanked.map(async (s) => {
        const raw = await findDuplicateCandidates(s.candidate.name, s.candidate.id, dataEnv)
        const scored: DuplicateCandidate[] = raw
          .map(d => ({ ...d, duplicateScore: calcDuplicateScore(d, s.candidate) }))
          .filter(d => d.duplicateScore >= 50)
          .sort((a, b) => b.duplicateScore - a.duplicateScore)
        return { candidateId: s.candidate.id, duplicates: scored }
      })
    ).then(results => {
      if (cancelled) return
      const map: Record<string, DuplicateCandidate[]> = {}
      results.forEach(r => { map[r.candidateId] = r.duplicates })
      setDuplicatesMap(map)
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [mode, selectedProjectId, dataEnv, selectedProjectRanked.length])

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
        : plist.length * BATCH_TOP_N
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
          「再実行」は、設定画面の実行モード（高速/全件）に従って更新します（高速は必須スキル重複が多い候補を優先して短時間）。
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

      {/* スコアウェイト調整パネル */}
      <div className="bg-white rounded-xl border border-gray-200 min-w-0">
        <button
          type="button"
          onClick={() => setShowWeightsPanel(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 rounded-xl transition-colors"
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-blue-600" />
            スコアウェイト調整（合計 {scoringWeights.skill + scoringWeights.exp + scoringWeights.rate + scoringWeights.location + scoringWeights.remote}pt）
          </span>
          <ChevronDown size={15} className={`text-gray-400 transition-transform ${showWeightsPanel ? 'rotate-180' : ''}`} />
        </button>
        {showWeightsPanel && (
          <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3">
            <p className="text-xs text-gray-500">マッチング実行前にここで重みを変更してください。変更は次回のマッチング実行時に反映されます。</p>
            {(
              [
                { key: 'skill', label: 'スキル一致', max: 100 },
                { key: 'exp', label: '経験年数', max: 50 },
                { key: 'rate', label: '単価合致', max: 50 },
                { key: 'location', label: '勤務地', max: 50 },
                { key: 'remote', label: 'リモート', max: 30 },
              ] as { key: keyof ScoringWeights; label: string; max: number }[]
            ).map(({ key, label, max }) => (
              <div key={key} className="flex items-center gap-3 min-w-0">
                <span className="text-xs text-gray-600 w-20 shrink-0">{label}</span>
                <input
                  type="range"
                  min={0}
                  max={max}
                  step={1}
                  value={scoringWeights[key]}
                  onChange={e => setScoringWeights(w => ({ ...w, [key]: Number(e.target.value) }))}
                  className="flex-1 accent-blue-600"
                />
                <span className="text-xs font-mono text-blue-700 w-8 text-right shrink-0">{scoringWeights[key]}pt</span>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setScoringWeights({ ...DEFAULT_SCORING_WEIGHTS })}
              className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
            >
              <RotateCcw size={11} />デフォルトに戻す（スキル40/経験15/単価15/勤務地20/リモート10）
            </button>
          </div>
        )}
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
                    {/* 案件詳細サマリー */}
                    <div className="text-xs space-y-1.5 bg-gray-50 rounded-lg px-3 py-2.5">
                      {(selectedProject.required_skills?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {(selectedProject.required_skills as string[]).slice(0, 10).map(s => (
                            <span key={s} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded">{s}</span>
                          ))}
                          {(selectedProject.required_skills?.length ?? 0) > 10 && (
                            <span className="text-gray-400">+{(selectedProject.required_skills?.length ?? 0) - 10}</span>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-gray-500">
                        {(selectedProject.budget_min != null || selectedProject.budget_max != null) && (
                          <span>単価: {selectedProject.budget_min ?? '?'}〜{selectedProject.budget_max ?? '?'}万</span>
                        )}
                        {selectedProject.work_location && (
                          <span>勤務地: {selectedProject.work_location}</span>
                        )}
                        {selectedProject.remote_policy && (
                          <span>リモート: {selectedProject.remote_policy}</span>
                        )}
                        {selectedProject.start_date && (
                          <span>開始: {selectedProject.start_date}</span>
                        )}
                      </div>
                      {(selectedProject.role_summary || selectedProject.description) && (
                        <p className="text-gray-500 line-clamp-2 leading-relaxed">
                          {(selectedProject.role_summary || selectedProject.description)?.slice(0, 150)}
                        </p>
                      )}
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
                              duplicates={duplicatesMap[s.candidate.id]}
                              requiredSkills={selectedProject.required_skills as string[]}
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
                                requiredSkills={selectedProject.required_skills as string[]}
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
