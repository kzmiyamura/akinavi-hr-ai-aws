import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertTriangle, Briefcase, User, RefreshCw, ChevronDown, CheckCircle, ChevronRight, Search, FileText, Mail, SlidersHorizontal, RotateCcw, Reply, ExternalLink, Star } from 'lucide-react'
import { toViewerUrl } from '../lib/viewerUrl'
import { CandidateProfileFields } from './CandidatePage'
import {
  fetchCandidatesForMatching,
  fetchCandidatesForProject,
  fetchCandidatesByIds,
  searchCandidatesForMatching,
  countCandidatesForMatching,
  findDuplicateCandidatesBatch,
  DEFAULT_SCORING_WEIGHTS,
} from '../lib/db/candidates'
import type { ScoringWeights } from '../lib/db/candidates'
import { logError } from '../lib/errorLog'
import {
  fetchOpenProjects,
  projectToMatchRequirements,
  projectsQueryKeys,
  fetchProjectsByIds,
  saveProjectMatchWeights,
} from '../lib/db/projects'
import {
  upsertSubmissions,
  fetchSubmissionsByProject,
  fetchSubmissionsByCandidate,
  fetchSubmissionStats,
} from '../lib/db/submissions'
import { supabase } from '../lib/supabase'
import { getMatchingSettings, MATCHING_DEFAULTS } from '../lib/db/matchingSettings'
import { fetchAgentDomainMap } from '../lib/db/agentCompanies'
import { fetchSkillMatches, NO_MATCHES } from '../lib/db/skillMatch'
import { getAiInterpretation, aiRelatedSkillMap, ecosystemCoverage } from '../lib/projectInterpretation'
import type { AiSpecialist } from '../lib/projectInterpretation'
import { RecommendationNote, getRecommendation, VERDICT_STYLE, compareByVerdictThenScore } from '../components/RecommendationNote'
import { MatchingInputs, MatchingWeightsLine, resolveScoringWeights } from '../components/MatchingInputs'
import type { SkillMatcher } from '../lib/db/skillMatch'
import { BookmarkStar } from '../components/BookmarkStar'
import { readBookmarkOnly, writeBookmarkOnly } from '../lib/bookmarkPref'
import { readRoleLevel, roleLevelNote, rateMismatch, ROLE_LEVEL_STYLE } from '../lib/roleLevel'
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
  /** 役割（スコア降順・先頭が主役割）。match-batch の役割加減点が roles[0] を見る */
  roles?: string[] | null
  agentComment?: string | null
  nationality?: string | null
  selfPR?: string | null
  skillYears?: Record<string, number> | null
  desiredProject?: string | null
  hakenOk?: boolean | null
  englishLevel?: 'business' | 'daily' | null
  employmentType?: string | null
  hakenLicenseVerified?: boolean | null
}

function toCandidateBatchInput(
  c: Candidate,
  agentMap?: Map<string, { license_status: string }>,
): CandidateBatchInput {
  const rp = c.raw_profile as Record<string, unknown>
  const employmentType = (rp?.employmentType as string | null) ?? null
  // 派遣社員の場合のみ、エージェントの派遣免許を確認
  let hakenLicenseVerified: boolean | null = null
  if (employmentType === '派遣社員' && agentMap) {
    const fromEmail = (rp?.from as string | undefined)
    const emailDomain = fromEmail?.split('@')[1]?.toLowerCase()
    const ls = emailDomain ? agentMap.get(emailDomain)?.license_status ?? null : null
    hakenLicenseVerified = ls === 'haken' || ls === 'both' ? true : ls === 'none' || ls === 'shokai' ? false : null
  }
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
    // 役割の加減点用。スコア降順なので先頭が主役割（match-batch 側で roles[0] を見る）
    roles: Array.isArray(rp?.roles) ? (rp.roles as string[]) : null,
    agentComment: (rp?.agentComment as string | null) ?? null,
    nationality: (rp?.nationality as string | null) ?? null,
    selfPR: (rp?.selfPR as string | null) ?? null,
    skillYears: (rp?.skillYears as Record<string, number> | null) ?? null,
    desiredProject: (rp?.desiredProject as string | null) ?? null,
    hakenOk: (rp?.hakenOk as boolean | null) ?? null,
    englishLevel: (rp?.englishLevel as 'business' | 'daily' | null) ?? null,
    employmentType,
    hakenLicenseVerified,
  }
}

async function matchBatchProjectToCandidates(
  projectReq: unknown,
  targets: Candidate[],
  onProgress: (done: number, total: number) => void,
  weights?: ScoringWeights,
  agentMap?: Map<string, { license_status: string }>,
): Promise<Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }>> {
  const resultMap = new Map<string, { score: number; summary: string; breakdown: string; ruleScore: number }>()

  // SQL 側でスコア順・日付順ソート済み。上位 BATCH_TOP_N 人だけ AI 採点。
  const aiTargets = targets.slice(0, BATCH_TOP_N)
  const ruleOnlyRest = targets.slice(BATCH_TOP_N)

  onProgress(0, targets.length)
  const { results } = await callMatchBatch('project_to_candidates', {
    projectRequirements: projectReq,
    candidates: aiTargets.map(c => toCandidateBatchInput(c, agentMap)),
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
        candidates: chunk.map(c => toCandidateBatchInput(c, agentMap)),
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
    workPrefecture: p.work_prefecture ?? null,
    skillWeights: p.skill_weights ?? null,
    requiredExpYears: p.required_experience_years ?? null,
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
  // 件数 × 人数の線形探索になっていたので Map で引く
  const byId = new Map(allCandidates.map((c) => [c.id, c]))
  return subs
    .map((s) => ({
      ...s,
      candidate: byId.get(s.candidate_id)!,
    }))
    .filter((s): s is RankedSubmission => Boolean(s.candidate))
}

// useQuery の既定値は毎回同じ参照を返さないと、useMemo の依存が毎レンダリング変わってしまう
const EMPTY_CANDIDATES: Candidate[] = []
const EMPTY_SUBMISSIONS: Submission[] = []
const EMPTY_DUPLICATE_ROWS: Record<string, Array<Omit<DuplicateCandidate, 'duplicateScore'>>> = {}

/**
 * 役割の合致度を画面用のラベルにする。
 * ⚠ 段階は DB の role_affinity / match-batch の roleAffinity と同じ意味にすること
 *   （同一1.0 / 同系統0.7 / 系統違い0.2）。重み30なので ±15〜-9pt になる。
 */
const ROLE_FAMILIES_UI: Record<string, string[]> = {
  'プロジェクトマネージャー': ['management'], 'PMO': ['management', 'support'],
  'プロジェクトリーダー': ['management'], 'スクラムマスター': ['management'],
  'コンサルタント': ['management'],
  'システムエンジニア': ['engineering'], 'プログラマー': ['engineering'],
  'テックリード': ['engineering', 'management'], 'アーキテクト': ['engineering', 'management'],
  'インフラエンジニア': ['engineering'], 'フロントエンドエンジニア': ['engineering'],
  'バックエンドエンジニア': ['engineering'], 'フルスタックエンジニア': ['engineering'],
  'クラウドエンジニア': ['engineering'], 'データエンジニア': ['engineering'],
  'MLエンジニア': ['engineering'],
  'ヘルプデスク': ['support'], '運用保守': ['support'], 'テストエンジニア': ['support'],
}
function roleAffinityLabel(required: string, candidate: string):
  { mark: string; cls: string; note: string } {
  if (required === candidate) {
    return { mark: '◎', cls: 'bg-emerald-100 text-emerald-800', note: '案件が求める役割と一致（+15pt）' }
  }
  const a = ROLE_FAMILIES_UI[required] ?? []
  const b = ROLE_FAMILIES_UI[candidate] ?? []
  if (a.some((f) => b.includes(f))) {
    return { mark: '○', cls: 'bg-emerald-50 text-emerald-700', note: '同じ系統の役割（+6pt）' }
  }
  return { mark: '×', cls: 'bg-red-50 text-red-700', note: '系統が違う役割（-9pt）' }
}

/**
 * 人材カード内の折りたたみ。
 * 採点材料を全部出したら情報量が多すぎたので、判断に直結するもの（順位・スコア・
 * 所見・役割・必須スキルの合致数）だけ開いたままにして、裏取り用の詳細は畳む
 * （2026-08-14 ユーザー指摘「出てる情報が多すぎる」）。
 * summary に要約を出すので、開かなくても状況は分かるようにする。
 */
function CardFold({ title, summary, children }: {
  title: string
  /** 畳んだままでも分かる一行要約 */
  summary?: ReactNode
  children: ReactNode
}) {
  return (
    <details className="group mt-1.5 rounded-md border border-slate-100 bg-slate-50/60 overflow-hidden">
      <summary className={`${accordionSummaryCls} px-2.5 py-1.5 text-[11px] text-slate-600 hover:bg-slate-100 cursor-pointer`}>
        <ChevronDown size={13} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
        <span className="font-medium">{title}</span>
        {summary && <span className="ml-1 text-slate-400 font-normal truncate">{summary}</span>}
      </summary>
      <div className="px-2.5 pb-2 pt-1">{children}</div>
    </details>
  )
}

/**
 * 技術圏の押さえ具合。必須スキルの個数だけでは
 * 「Microsoft圏に広く精通した人」を見分けられない（2026-08-13 指摘）。
 * 「圏」が何を指すのかが分からないという指摘（2026-08-14）を受けて title で説明する。
 */
function EcosystemCoverageNote({ specialist, cov }: {
  specialist: AiSpecialist
  cov: { hit: string[]; total: number; ratio: number }
}) {
  const strong = cov.ratio >= 0.6
  // 0件なのに「部分的」と出ていて意味が通らなかった（2026-08-14 指摘）
  const label = cov.hit.length === 0 ? '該当なし' : strong ? 'この圏に広く精通' : '一部のみ'
  return (
    <div className={`mt-1.5 rounded-md border px-2.5 py-1.5 ${strong ? 'bg-violet-50 border-violet-200' : 'bg-white border-slate-200'}`}>
      <span
        className={`text-xs font-medium ${strong ? 'text-violet-700' : 'text-gray-500'}`}
        title={`「${specialist.ecosystem}圏」＝この案件は ${specialist.ecosystem} 系の技術に広く精通した人を求めている、という AI の読みです。`
          + `\n${specialist.reason ? `根拠: ${specialist.reason}\n` : ''}`
          + `圏の技術（${cov.total}件）: ${specialist.coreSkills.join('、')}`
          + `\nこの人が持っているのは ${cov.hit.length} 件です。`}
      >
        {specialist.ecosystem}圏 {cov.hit.length}/{cov.total}
      </span>
      <span className="text-[10px] text-gray-400 ml-1">{label}</span>
      {cov.hit.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {cov.hit.map(h => (
            <span key={h} className="text-[10px] rounded px-1 py-0.5 bg-white border border-violet-200 text-violet-700">{h}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 一覧に出す件数。それ以上はアコーディオン内へ */
const RANK_HEAD = 5
/** 案件を選んだ直後に引く件数。営業が見るのは上位数名で、残りはアコーディオンの中。
 *  200件を先読みすると submissions + 人材 + 重複チェックで 1.4MB 無駄になる（2026-08-14 実測）。
 *
 *  1人あたり約8KB（submissions 0.8KB + 人材 3.8KB + 重複チェック 3.4KB）。
 *  2026-08-20 に 20 → 10 へ（案件1クリック 160KB → 80KB）。
 *  RANK_HEAD(5) ちょうどにしないのは、取得後に verdict（推せる/条件付き/見送り）で
 *  並び替えるため。5件しか持たないと「上位5名に見送りが混ざっても、
 *  6位以降の良い人と入れ替えられない」状態になる。表示5名＋入れ替え用の予備5名にする。 */
const RANK_FETCH_INITIAL = 10
/** アコーディオン内「もっと見る」1回で追加する件数。
 *  1回押すたびに submissions + 人材 + 重複チェックが増えるので小刻みにする */
const RANK_FETCH_STEP = 5
/** 何回押しても引く上限（元の挙動と同じ） */
const RANK_FETCH_MAX = 200
/** スキルタグの常時表示数。それ以上はアコーディオン内へ */
const SKILL_HEAD = 12

const accordionSummaryCls =
  'flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden'

/**
 * スキル判定ルールを最後に変えた日時（UTC）。
 * これより前に保存されたスコア内訳は、いまの緑/グレー表示と食い違うことがある
 * （2026-08-13 に Microsoft スタックの表記ゆれを skill_master に入れ、
 *   尚可スキルと重み付けを順位付けSQLに反映した）。
 * 判定を変えたらこの値も更新すること。
 */
const SCORE_LOGIC_UPDATED_AT = Date.parse('2026-08-13T08:10:00Z')

/** 内訳テキスト「必須5中3合致」から保存時の合致数を読む。読めなければ null */
export function parseSavedSkillHits(breakdown: string): { total: number; hits: number } | null {
  const m = breakdown.match(/必須(\d+)中(\d+)合致/)
  if (!m) return null
  return { total: Number(m[1]), hits: Number(m[2]) }
}

/**
 * スコア内訳。保存済みの計算結果なので、いつ算出したものかを必ず出す。
 *
 * 必須スキルの緑／グレーは毎回サーバに問い合わせる live 判定なので、
 * 保存済みの内訳と合致数が食い違う。「食い違うことがあります」と
 * 曖昧に書いていたが、それでは何個が正しいのか分からない（2026-08-13 指摘:
 * 「緑色が5個中4個あるのになぜ3個なの？」）。live の合致数を渡して、
 * 保存時と最新の数を両方そのまま出す。
 */
function ScoreBreakdown({ breakdown, updatedAt, liveHits }: {
  breakdown: string
  updatedAt?: string | null
  /** 最新判定での必須スキル合致数。渡せない画面（人材モード）では undefined */
  liveHits?: number
}) {
  const at = updatedAt ? Date.parse(updatedAt) : NaN
  const saved = parseSavedSkillHits(breakdown)
  const disagrees = saved != null && liveHits != null && saved.hits !== liveHits
  // 判定ルール更新より前のものは、合致数が一致していても他の軸が変わっている可能性がある
  const olderThanLogic = Number.isFinite(at) && at < SCORE_LOGIC_UPDATED_AT
  const stale = disagrees || olderThanLogic
  return (
    <>
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
        スコア内訳（ルールベース）
        {Number.isFinite(at) && (
          <span className="ml-1 font-normal normal-case text-gray-400">
            算出 {new Date(at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </p>
      <p className="text-xs text-gray-600 break-words leading-relaxed font-mono">{breakdown}</p>
      {stale && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-1">
          {disagrees && saved
            ? <>この内訳は保存時（{saved.total}中{saved.hits}合致）の値です。最新の判定では <span className="font-semibold">{saved.total}中{liveHits}合致</span>（上の緑がその結果）です。スキルの点数と合計スコアは、再計算するとこの内訳より{liveHits! > saved.hits ? '高く' : '低く'}なります。「再マッチング」で更新されます。</>
            : <>スキル判定ルールを更新する前の結果です。上の必須スキルの緑／グレーは最新の判定なので、合致数が食い違うことがあります。「再マッチング」で更新されます。</>}
        </p>
      )}
    </>
  )
}

function SkillTagsWithAccordion({ skills, highlightSkills = [], niceHighlightSkills = [] }: { skills: string[], highlightSkills?: string[], niceHighlightSkills?: string[] }) {
  if (skills.length === 0) return null
  const hlSet = new Set(highlightSkills.map(s => s.toLowerCase()))
  const niceSet = new Set(niceHighlightSkills.map(s => s.toLowerCase()))
  const tagCls = (sk: string) => {
    const skl = sk.toLowerCase()
    if (hlSet.size > 0 && hlSet.has(skl)) return 'text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5 font-medium'
    if (niceSet.size > 0 && niceSet.has(skl)) return 'text-xs bg-violet-100 text-violet-700 rounded px-1.5 py-0.5 font-medium'
    return 'text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5'
  }
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
  onLoadMore,
  remaining,
  loading,
}: {
  count: number
  /** 例: 「名」「件の案件」 */
  unitLabel: string
  children: ReactNode
  /** 続きを引く。閉じている間はもちろん、開いても押すまで転送しない */
  onLoadMore?: () => void
  /** まだ取得していない件数。0 なら「もっと見る」を出さない */
  remaining?: number
  loading?: boolean
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
      <div className="space-y-3 px-3 sm:px-4 py-4 bg-slate-50/40 min-w-0">
        {children}
        {onLoadMore && (remaining ?? 0) > 0 && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="w-full py-2 text-xs font-medium text-blue-700 bg-white border border-slate-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
          >
            {loading ? '読み込み中...' : `もっと見る（残り${remaining}${unitLabel}）`}
          </button>
        )}
      </div>
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
  niceToHaveSkills = [],
  aiNiceSkills,
  specialist,
  requiredRole,
  skillMatcher = NO_MATCHES,
  agentDomainMap,
}: {
  s: RankedSubmission
  rankIndex: number
  onOpenCandidateDetail?: (candidateId: string) => void
  scoreColor: (score: number) => string
  onDecide?: (submission: Submission) => void
  duplicates?: DuplicateCandidate[]
  requiredSkills?: string[]
  niceToHaveSkills?: string[]
  /** AIが解釈で足した尚可スキル（name小文字→根拠）。出所バッジ表示用 */
  aiNiceSkills?: Map<string, string | null>
  /** AIが読んだ「この案件が求める技術圏」。押さえ具合をカードに出す */
  specialist?: AiSpecialist | null
  /** AIが読んだ「この案件が求める役割」。人材の主役割との合致が順位に±する */
  requiredRole?: string | null
  /** スキル一致判定。サーバの skill_satisfies と同じ結果になる（src/lib/db/skillMatch.ts） */
  skillMatcher?: SkillMatcher
  agentDomainMap?: Map<string, { license_status: string }>
}) {
  const [showEmail, setShowEmail] = useState(false)
  const rawText = (s.candidate.raw_profile as Record<string, unknown>)?.text as string | undefined
  // 雇用形態・派遣免許バッジ
  const fromEmail = (s.candidate.raw_profile as Record<string, unknown>)?.from as string | undefined
  const emailDomain = fromEmail?.split('@')[1]?.toLowerCase()
  const licenseStatus = emailDomain && agentDomainMap ? agentDomainMap.get(emailDomain)?.license_status ?? null : null
  const employmentType = (s.candidate.raw_profile as Record<string, unknown>)?.employmentType as string | null
  const isHaken = employmentType === '派遣社員'
  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden bg-white min-w-0">
    <div className="p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex gap-3 min-w-0 flex-1">
        <div className="text-xl sm:text-2xl font-bold text-gray-300 w-7 sm:w-8 text-center shrink-0">
          {rankIndex + 1}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <BookmarkStar
              candidateId={s.candidate.id}
              dataEnv={s.candidate.data_env}
              bookmarked={s.candidate.bookmarked === true}
            />
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
            {employmentType && (
              <span className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{employmentType}</span>
            )}
            {isHaken && (
              licenseStatus === 'haken' || licenseStatus === 'both' ? (
                <span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1.5 py-0.5 font-medium">派遣免許あり</span>
              ) : licenseStatus === 'none' ? (
                <span className="flex items-center gap-0.5 text-[10px] bg-red-100 text-red-600 rounded px-1.5 py-0.5 font-medium">
                  <AlertTriangle size={10} />派遣免許なし
                </span>
              ) : licenseStatus === 'shokai' ? (
                <span className="flex items-center gap-0.5 text-[10px] bg-orange-100 text-orange-600 rounded px-1.5 py-0.5 font-medium">
                  <AlertTriangle size={10} />派遣免許なし（紹介のみ）
                </span>
              ) : (
                <span className="text-[10px] bg-yellow-100 text-yellow-700 rounded px-1.5 py-0.5">派遣免許未確認</span>
              )
            )}
          </div>
          {(() => {
            const rp2 = s.candidate.raw_profile as Record<string, unknown>
            const age = rp2?.age as number | null
            const gender = rp2?.gender as string | null
            const prefecture = rp2?.prefecture as string | null
            const nearestStation = rp2?.nearestStation as string | null
            const wantsFullRemote = rp2?.wantsFullRemote as boolean | null
            const agentComment = rp2?.agentComment as string | null
            // スコアの根拠になっている項目は画面に出す。
            // 内訳に「リモート5/5(常駐可・派遣案件)」と書いてあっても、カードに可否が
            // 出ていないと営業が裏を取れず、判定そのものが疑われる（2026-08-13 指摘）
            const remoteAvailable = rp2?.remoteAvailable as boolean | null | undefined
            const hakenOk = rp2?.hakenOk as boolean | null | undefined
            const workStyleNote = rp2?.workStyleNote as string | null
            const location = [prefecture, nearestStation].filter(Boolean).join(' / ')
            return (
              <>
                <p className="text-xs text-gray-500 mt-0.5">
                  {[s.candidate.from_company, s.candidate.desired_rate].filter(Boolean).join(' ／ ')}
                  {(s.candidate.from_company || s.candidate.desired_rate) && (age != null || gender) ? ' ／ ' : ''}
                  {age != null ? `${age}歳` : ''}
                  {gender ? `（${gender}）` : ''}
                </p>
                {location && (
                  <p className="text-xs text-gray-400 mt-0.5">{location}</p>
                )}
                {/* 役割だけは畳まない。「PMOかどうか」が一目で分かる必要がある
                    （2026-08-14 指摘）。他の採点材料は下の折りたたみへ */}
                {(() => {
                  const mainRole = Array.isArray(rp2?.roles) ? (rp2.roles as string[])[0] ?? null : null
                  const subRoles = Array.isArray(rp2?.roles) ? (rp2.roles as string[]).slice(1, 3) : []
                  const aff = requiredRole && mainRole ? roleAffinityLabel(requiredRole, mainRole) : null
                  // 到達レベル（2026-09-01）。同じ「PMO」でも、官公庁のRFP評価をやった人と
                  // 議事録・PC手配の人がいる。実測で平均希望単価が31万違う。落とさずに見せる
                  const level = readRoleLevel(rp2 as Record<string, unknown> | null, mainRole)
                  const mismatch = rateMismatch(level, s.candidate.desired_rate)
                  if (!mainRole && !requiredRole) return null
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {mainRole ? (
                        <span
                          className={`text-[10px] rounded px-1.5 py-0.5 font-medium ${aff?.cls ?? 'bg-gray-100 text-gray-600'}`}
                          title={requiredRole
                            ? `この案件が求める役割: ${requiredRole}／この人の主役割: ${mainRole}${subRoles.length ? `（他に ${subRoles.join('・')}）` : ''}\n${aff?.note ?? ''}`
                            : `この人の主役割: ${mainRole}${subRoles.length ? `（他に ${subRoles.join('・')}）` : ''}`}
                        >
                          役割: {mainRole}{aff ? ` ${aff.mark}` : ''}
                        </span>
                      ) : (
                        <span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5"
                          title={`経歴から役割を読み取れなかったため加減点なし（案件は ${requiredRole} を求めています）`}>
                          役割: 判定不可
                        </span>
                      )}
                      {mainRole && level && (
                        <span
                          className={`text-[10px] rounded px-1.5 py-0.5 font-medium ${ROLE_LEVEL_STYLE[level].cls}`}
                          title={roleLevelNote(mainRole, level)}
                        >
                          {ROLE_LEVEL_STYLE[level].mark}
                        </span>
                      )}
                      {mismatch && (
                        <span
                          className="text-[10px] rounded px-1.5 py-0.5 font-medium bg-rose-100 text-rose-700"
                          title={mismatch.note}
                        >
                          単価要確認
                        </span>
                      )}
                    </div>
                  )
                })()}
                {/* ── 勤務条件・雇用形態（畳む）──
                    いずれもスコアを±させるので出すが、常時展開すると
                    バッジが6個並んで読めなくなる（2026-08-14 指摘）。
                    畳んだままでも要点が分かるよう summary に凝縮する */}
                {(() => {
                  const englishLevel = rp2?.englishLevel as string | null
                  const remoteLabel = wantsFullRemote ? 'リモートのみ'
                    : remoteAvailable === true ? 'リモート可'
                    : remoteAvailable === false ? 'リモート記載なし' : 'リモート不明'
                  const hakenLabel = hakenOk === true ? '常駐可' : hakenOk === false ? '派遣NG' : null
                  const summary = [remoteLabel, hakenLabel].filter(Boolean).join(' ・ ')
                  return (
                    <CardFold title="勤務条件" summary={summary}>
                      <div className="flex flex-wrap gap-1">
                        {wantsFullRemote && (
                          <span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1.5 py-0.5 font-medium">リモートのみ</span>
                        )}
                        {/* リモート可否は3値をそのまま出す（記載なしを「不可」と書かない） */}
                        {!wantsFullRemote && remoteAvailable === true && (
                          <span className="text-[10px] bg-blue-50 text-blue-700 rounded px-1.5 py-0.5" title={workStyleNote ?? undefined}>リモート可</span>
                        )}
                        {remoteAvailable === false && (
                          <span className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5" title={workStyleNote ?? undefined}>リモート可の記載なし</span>
                        )}
                        {remoteAvailable == null && (
                          <span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">リモート記載なし</span>
                        )}
                        {/* 派遣NG=20pt上限 / 常駐可=+5pt */}
                        {hakenOk === true && (
                          <span className="text-[10px] bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5">常駐・派遣可</span>
                        )}
                        {hakenOk === false && (
                          <span className="text-[10px] bg-amber-50 text-amber-700 rounded px-1.5 py-0.5">派遣NG</span>
                        )}
                        {/* 雇用形態と派遣免許はカード上部のバッジ列に既にある（そちらは
                            「免許なし」「紹介のみ」まで出す詳しい版）。ここでは重複させない */}
                        {/* 案件が英語要件を持つとき +2〜8pt */}
                        {englishLevel && (
                          <span className="text-[10px] bg-sky-50 text-sky-700 rounded px-1.5 py-0.5"
                            title="案件が英語要件を持つ場合に加点されます（ビジネス +8pt / 日常会話 +2pt）">
                            英語: {englishLevel === 'business' ? 'ビジネス' : englishLevel === 'daily' ? '日常会話' : englishLevel}
                          </span>
                        )}
                      </div>
                      {/* 判定の元になった原文。これが無いと可否の裏が取れない */}
                      {workStyleNote && (
                        <p className="text-[10px] text-gray-500 mt-1 whitespace-pre-wrap break-words">
                          勤務形態の原文: {workStyleNote}
                        </p>
                      )}
                    </CardFold>
                  )
                })()}
                {agentComment && (
                  <CardFold title="エージェントコメント" summary={agentComment.slice(0, 24) + (agentComment.length > 24 ? '…' : '')}>
                    <p className="text-xs text-amber-900 whitespace-pre-wrap leading-relaxed">{agentComment}</p>
                  </CardFold>
                )}
              </>
            )
          })()}
          {/* ── スキルの合致（畳む）──
              保有スキル一覧・技術圏・必須/尚可の照合を1つにまとめる。
              畳んだままでも「必須 2/5 合致」が summary で読めるようにする */}
          {(() => {
            const allSkills = (s.candidate.skills as string[]) ?? []
            const skillMatch = (sk: string, list: string[]) => list.some(r => skillMatcher(sk, r))
            const reqMatched = allSkills.filter(sk => skillMatch(sk, requiredSkills))
            const niceMatched = allSkills.filter(sk => !skillMatch(sk, requiredSkills) && skillMatch(sk, niceToHaveSkills))
            const unmatched = allSkills.filter(sk => !skillMatch(sk, requiredSkills) && !skillMatch(sk, niceToHaveSkills))
            const reqHit = requiredSkills.filter(r => allSkills.some(sk => skillMatcher(sk, r))).length
            const cov = specialist ? ecosystemCoverage(specialist, allSkills, skillMatcher) : null
            const summary = [
              requiredSkills.length > 0 ? `必須 ${reqHit}/${requiredSkills.length} 合致` : null,
              cov ? `${specialist!.ecosystem}圏 ${cov.hit.length}/${cov.total}` : null,
            ].filter(Boolean).join(' ・ ')
            return (
              <CardFold title="スキルの合致" summary={summary}>
                <SkillTagsWithAccordion skills={[...reqMatched, ...niceMatched, ...unmatched]} highlightSkills={reqMatched} niceHighlightSkills={niceMatched} />
                {/* 案件の必須／尚可スキルとの照合 */}
                {(requiredSkills.length > 0 || niceToHaveSkills.length > 0) && (
                  <div className="mt-1.5 space-y-1.5">
                    {requiredSkills.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">必須スキル</p>
                        <div className="flex flex-wrap gap-1">
                          {requiredSkills.map(req => (
                            <span key={req} className={allSkills.some(sk => skillMatcher(sk, req))
                              ? 'text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5 font-medium'
                              : 'text-xs bg-gray-100 text-gray-400 rounded px-1.5 py-0.5 line-through'
                            }>{req}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {niceToHaveSkills.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">尚可スキル</p>
                        <div className="flex flex-wrap gap-1">
                          {niceToHaveSkills.map(nice => {
                            const aiReason = aiNiceSkills?.get(nice.trim().toLowerCase())
                            const isAi = aiNiceSkills?.has(nice.trim().toLowerCase()) ?? false
                            return (
                              <span key={nice}
                                title={isAi ? `AIの解釈: ${aiReason ?? '業務内容から読める関連スキル'}` : undefined}
                                className={allSkills.some(sk => skillMatcher(sk, nice))
                                  ? `text-xs bg-violet-100 text-violet-700 rounded px-1.5 py-0.5 font-medium${isAi ? ' border border-dashed border-violet-300' : ''}`
                                  : `text-xs bg-gray-100 text-gray-400 rounded px-1.5 py-0.5${isAi ? ' border border-dashed border-gray-300' : ''}`
                                }>{nice}{isAi && <span className="opacity-60 ml-0.5">AI</span>}</span>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* 技術圏の押さえ具合。必須スキルの個数だけでは
                    「Microsoft圏に広く精通した人」を見分けられない（2026-08-13 指摘） */}
                {specialist && cov && <EcosystemCoverageNote specialist={specialist} cov={cov} />}
              </CardFold>
            )
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
          {/* 点数の前に、営業がそのまま使える所見を出す（2026-08-13 指摘） */}
          {(() => {
            const rec = getRecommendation(s.ai_raw)
            return rec ? <RecommendationNote rec={rec} /> : null
          })()}
          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2 min-w-0 space-y-2">
            {s.ai_summary && (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed">{s.ai_summary}</p>
              </>
            )}
            {(s.ai_raw as Record<string, unknown>)?.breakdown ? (
              <ScoreBreakdown
                breakdown={String((s.ai_raw as Record<string, unknown>).breakdown)}
                updatedAt={s.updated_at}
                // 緑バッジと同じ live 判定で数え直した合致数。内訳の保存値と突き合わせる
                liveHits={requiredSkills.length > 0
                  ? requiredSkills.filter(req =>
                      ((s.candidate.skills as string[]) ?? []).some(sk => skillMatcher(sk, req))).length
                  : undefined}
              />
            ) : !s.ai_summary && (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-400">（理由テキストなし）</p>
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
        {/* 点数は単語一致ベースで職種の適合（PMO≠実装者）を見ない。所見の判断を
            点数の真横に出し、「95点」と「条件付き」が同時に見えるようにする（2026-08-14 指摘） */}
        {(() => {
          const v = getRecommendation(s.ai_raw)?.verdict
          return v ? (
            <span
              className={`inline-flex items-center justify-center rounded border text-xs font-medium px-2 py-0.5 ${VERDICT_STYLE[v] ?? ''}`}
              title="AIが案件本文と経歴を読み合わせた判断。根拠はカード内の「提案所見」"
            >
              AI: {v}
            </span>
          ) : null
        })()}

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
      if (deduped.length === 0) return null
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
                // カード全体を押せるようにする（2026-08-20 ユーザー要望）。
                // 以前は氏名のテキストだけがリンクで、押せる範囲が分かりにくかった
                <div
                  key={d.id}
                  role={onOpenCandidateDetail ? 'button' : undefined}
                  tabIndex={onOpenCandidateDetail ? 0 : undefined}
                  onClick={onOpenCandidateDetail ? () => onOpenCandidateDetail(d.id) : undefined}
                  onKeyDown={onOpenCandidateDetail
                    ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenCandidateDetail(d.id) } }
                    : undefined}
                  title={onOpenCandidateDetail ? `${d.name} の詳細を開く（${d.from_company ?? '会社不明'}からの情報）` : undefined}
                  className={`flex flex-col gap-0.5 text-xs bg-white rounded px-2.5 py-1.5 border border-amber-200 ${
                    onOpenCandidateDetail ? 'cursor-pointer hover:bg-amber-50 hover:border-amber-400 transition-colors' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className={`font-medium text-gray-800 ${onOpenCandidateDetail ? 'underline decoration-dotted underline-offset-2' : ''}`}>
                      {d.name}
                    </span>
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
          {/* 案件ごとに配点が違うので、どの案件がどの軸を重く見ているかを行単位で出す。
              値が取れていない軸は順位に効かないため赤で示す（2026-08-13） */}
          {p && <MatchingWeightsLine project={p} />}
          {(() => {
            const rec = getRecommendation(s.ai_raw)
            return rec ? <RecommendationNote rec={rec} /> : null
          })()}
          <div className="mt-2 rounded-md bg-slate-50 border border-slate-100 px-2.5 py-2 min-w-0 space-y-2">
            {s.ai_summary && (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed">{s.ai_summary}</p>
              </>
            )}
            {(s.ai_raw as Record<string, unknown>)?.breakdown ? (
              <ScoreBreakdown
                breakdown={String((s.ai_raw as Record<string, unknown>).breakdown)}
                updatedAt={s.updated_at}
              />
            ) : !s.ai_summary && (
              <>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">マッチング理由（AI）</p>
                <p className="text-xs text-gray-400">（理由テキストなし）</p>
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
        {/* 点数は単語一致ベースで職種の適合（PMO≠実装者）を見ない。所見の判断を
            点数の真横に出し、「95点」と「条件付き」が同時に見えるようにする（2026-08-14 指摘） */}
        {(() => {
          const v = getRecommendation(s.ai_raw)?.verdict
          return v ? (
            <span
              className={`inline-flex items-center justify-center rounded border text-xs font-medium px-2 py-0.5 ${VERDICT_STYLE[v] ?? ''}`}
              title="AIが案件本文と経歴を読み合わせた判断。根拠はカード内の「提案所見」"
            >
              AI: {v}
            </span>
          ) : null
        })()}

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
  const [savingWeights, setSavingWeights] = useState(false)
  const [requireHaken, setRequireHaken] = useState(false)
  // エージェント会社マスタはほぼ不変。3分で失効させると画面を触るたびに引き直す
  const { data: agentDomainMap } = useQuery({
    queryKey: ['agentDomainMap'],
    queryFn: fetchAgentDomainMap,
    staleTime: 60 * 60_000,
  })
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
  // 人材モードの左ペインは、検索もページングもサーバー側でやる。
  // 以前は全 1,521件（5.25MB）を引いてクライアントで絞っていた（2026-08-14 に是正）。
  // 案件モードのランキング表示に要る人材は candidatesForRanking（IDs 指定）で取る。
  const searchKeywords = useMemo(
    () => searchQuery.trim().toLowerCase().split(/[\s　]+/).filter(Boolean),
    [searchQuery],
  )
  const searchKeywordsKey = searchKeywords.join(',')

  // 検索条件が変わったら表示件数を初期値へ。前の検索で 500 件まで開いていた状態を
  // 引き継ぐと、新しい検索でいきなり 500 件引いてしまう
  useEffect(() => { setCandidateDisplayLimit(50) }, [searchKeywordsKey, searchMode])

  // 「★のみ表示」は端末ごとの設定（星そのものはチーム共有で DB にある）。
  // 人材タブとは別に持つので、片方で絞ってももう片方には影響しない
  const [bookmarkOnly, setBookmarkOnly] = useState(() => readBookmarkOnly('matching'))

  const { data: candidates = EMPTY_CANDIDATES, isLoading: isLoadingCandidates } = useQuery({
    queryKey: ['candidates-page', dataEnv, searchKeywordsKey, searchMode, candidateDisplayLimit, bookmarkOnly],
    queryFn: () =>
      searchCandidatesForMatching(dataEnv, searchKeywords, searchMode, candidateDisplayLimit, 0, bookmarkOnly),
    enabled: mode === 'candidate',
    placeholderData: (prev) => prev, // 「もっと見る」で一覧が消えないように
  })

  // 「全N件」表示と一括ボタンの活性判定に使う。本体は転送しない
  const { data: candidateCount = 0 } = useQuery({
    queryKey: ['candidate-count', dataEnv, searchKeywordsKey, searchMode],
    queryFn: () => countCandidatesForMatching(dataEnv, searchKeywords, searchMode),
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

  // \u7d5e\u308a\u8fbc\u307f\u306f search_candidates_for_matching \u304c\u6e08\u307e\u305b\u3066\u3044\u308b\u306e\u3067\u3001\u3053\u3053\u3067\u306f\u4f55\u3082\u3057\u306a\u3044
  const filteredCandidateList = candidateList

  // 引く件数は「上位20件」から始め、アコーディオン内の「もっと見る」で5件ずつ足す。
  // 全件先読みは submissions + 人材 + 重複チェックで 1.4MB/クリックの無駄だった
  const [rankFetchLimit, setRankFetchLimit] = useState(RANK_FETCH_INITIAL)

  const {
    data: submissionsForSelectedProject = EMPTY_SUBMISSIONS,
    isLoading: isLoadingProjectSubs,
    isFetching: isFetchingProjectSubs,
  } = useQuery({
    queryKey: ['matching-submissions-for-project', dataEnv, selectedProjectId, rankFetchLimit],
    queryFn: () => fetchSubmissionsByProject(selectedProjectId!, dataEnv, rankFetchLimit),
    enabled: mode === 'project' && !!selectedProjectId,
    placeholderData: (prev) => prev, // 展開時に既存の上位20件を消さない（画面がちらつく）
  })

  const { data: submissionsForSelectedCandidate = [], isLoading: isLoadingCandidateSubs } = useQuery({
    queryKey: ['matching-submissions-for-candidate', dataEnv, selectedCandidateId],
    queryFn: () => fetchSubmissionsByCandidate(selectedCandidateId!, dataEnv),
    enabled: mode === 'candidate' && !!selectedCandidateId,
  })

  // 案件モードのランキングに要る人材だけを ID 指定で取る（全人材を引かないため）
  const rankingCandidateIds = useMemo(() => {
    const ids = [...new Set(submissionsForSelectedProject.map((s) => s.candidate_id))]
    ids.sort()
    return ids
  }, [submissionsForSelectedProject])
  const rankingCandidateIdsKey = rankingCandidateIds.join(',')

  const { data: candidatesForRanking = EMPTY_CANDIDATES, isLoading: isLoadingRankingCandidates } = useQuery({
    queryKey: ['matching-ranking-candidates', dataEnv, rankingCandidateIdsKey],
    queryFn: () => fetchCandidatesByIds(rankingCandidateIds, dataEnv),
    enabled: mode === 'project' && rankingCandidateIds.length > 0,
  })

  // 人材モードでは既に全件持っているので使い回す
  const rankingCandidates = mode === 'project' ? candidatesForRanking : (candidates as Candidate[])

  const sortedSelectedProjectSubs = useMemo(
    () => [...submissionsForSelectedProject].sort(compareByVerdictThenScore),
    [submissionsForSelectedProject],
  )
  const sortedSelectedCandidateSubs = useMemo(
    () => [...submissionsForSelectedCandidate].sort(compareByVerdictThenScore),
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
    queryClient.invalidateQueries({ queryKey: ['candidate-count', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['matching-ranking-candidates', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['matching-duplicates', dataEnv] })
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
        { requiredSkills: project.required_skills as string[], budgetMin: project.budget_min, budgetMax: project.budget_max, workLocation: project.work_location, workPrefecture: project.work_prefecture, requiredExpYears: project.required_experience_years, skillWeights: project.skill_weights, niceToHaveSkills: projectReq.niceToHaveSkills, contractType: project.contract_type, remotePolicy: project.remote_policy, requiredRole: getAiInterpretation(project.raw_data)?.requiredRole ?? null, weights: scoringWeights },
        dataEnv,
        sqlLimit,
        requireHaken,
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
          agentDomainMap,
        )

        // 1件ずつ往復すると全件モード（最大500件）で数十秒かかるのでまとめて保存する
        await upsertSubmissions(
          targets.flatMap(candidate => {
            const r = resultMap.get(candidate.id)
            if (!r) return []
            return [{
              candidateId: candidate.id,
              projectId,
              matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
              breakdown: r.breakdown,
              createdBy: nickname,
              dataEnv,
            }]
          }),
        )
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
      // 一覧はページングされているので、居なければ ID 指定で取り直す
      const candidate =
        (candidates as Candidate[]).find((c) => c.id === candidateId)
        ?? (await fetchCandidatesByIds([candidateId], dataEnv))[0]
      if (!candidate) throw new Error('人材が見つかりません')
      if ((projects as Project[]).length === 0) throw new Error('募集中の案件がありません')

      const targetProjects = pickProjectsForCandidateMatch(candidate, projects as Project[], matchingRunMode, fastMaxProjects)
      const total = targetProjects.length
      if (total === 0) return

      try {
        setMatchRunProgressNow({ overall: { done: 0, total }, inner: { current: 0, total, unit: '案件' } })

        const candidateInput = toCandidateBatchInput(candidate, agentDomainMap)
        const resultMap = await matchBatchCandidateToProjects(
          candidateInput,
          targetProjects,
          (done, t) => setMatchRunProgressNow({ overall: { done, total: t }, inner: { current: done, total: t, unit: '案件' } }),
          scoringWeights,
        )

        await upsertSubmissions(
          targetProjects.flatMap(project => {
            const r = resultMap.get(project.id)
            if (!r) return []
            return [{
              candidateId: candidate.id,
              projectId: project.id,
              matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
              breakdown: r.breakdown,
              createdBy: nickname,
              dataEnv,
            }]
          }),
        )
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
            { requiredSkills: project.required_skills as string[], budgetMin: project.budget_min, budgetMax: project.budget_max, workLocation: project.work_location, workPrefecture: project.work_prefecture, requiredExpYears: project.required_experience_years, skillWeights: project.skill_weights, niceToHaveSkills: projectReq.niceToHaveSkills, contractType: project.contract_type, remotePolicy: project.remote_policy, requiredRole: getAiInterpretation(project.raw_data)?.requiredRole ?? null, weights: scoringWeights },
            dataEnv,
            sqlLimit2,
            project.contract_type === '派遣' ? requireHaken : false,
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
              agentDomainMap,
            )
          } catch (err) {
            console.warn(`[bulk-match] ${project.title} バッチ失敗: ${err}`)
          }

          if (bulkCancelRequestedRef.current) {
            setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, projectTotal) })
            return
          }
          try {
            await upsertSubmissions(
              targets.flatMap(candidate => {
                const r = resultMap.get(candidate.id)
                if (!r) return []
                return [{
                  candidateId: candidate.id,
                  projectId: project.id,
                  matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
                  breakdown: r.breakdown,
                  createdBy: nickname,
                  dataEnv,
                }]
              }),
            )
          } catch (err) {
            console.warn(`[bulk-match] ${project.title} 保存失敗: ${err}`)
          }
          done += targets.length
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
      // 左ペインは50件しか持っていないので、ここで全件取る。
      // 5MB 級の転送だが「全人材を再マッチング」を押したときだけ発生する
      const clist = await fetchCandidatesForMatching(dataEnv)
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

          const candidateInput = toCandidateBatchInput(candidate, agentDomainMap)
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

          if (bulkCancelRequestedRef.current) {
            setMessage({ type: 'success', text: bulkMatchInterruptMessage(done, total) })
            return
          }
          try {
            await upsertSubmissions(
              targetProjects.flatMap(project => {
                const r = resultMap.get(project.id)
                if (!r) return []
                return [{
                  candidateId: candidate.id,
                  projectId: project.id,
                  matchResult: { score: r.score, summary: r.summary, duplicateSuspected: false, ruleScore: r.ruleScore },
                  breakdown: r.breakdown,
                  createdBy: nickname,
                  dataEnv,
                }]
              }),
            )
          } catch (err) {
            console.warn(`[bulk-match] ${candidate.name} 保存失敗: ${err}`)
          }
          done += targetProjects.length
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
  const aiCountByProject = stats?.aiCountByProjectId ?? {}
  const aiCountByCandidate = stats?.aiCountByCandidateId ?? {}

  const selectedProject = projectList.find((p) => p.id === selectedProjectId) ?? null
  // 選択中の人材が、検索や「もっと見る」の結果いま引いているページに居ないことがある。
  // その場合だけ ID 指定で1件取りに行く（一覧を引き直さない）
  const selectedInPage = candidateList.find((c) => c.id === selectedCandidateId) ?? null
  const { data: selectedCandidateFallback } = useQuery({
    queryKey: ['matching-selected-candidate', dataEnv, selectedCandidateId],
    queryFn: () => fetchCandidatesByIds([selectedCandidateId!], dataEnv),
    enabled: mode === 'candidate' && !!selectedCandidateId && !selectedInPage,
  })
  const selectedCandidate = selectedInPage ?? selectedCandidateFallback?.[0] ?? null

  // 案件選択時: 保存済みウェイト → なければ案件内容から自動計算。派遣案件なら派遣フィルターを自動ON
  useEffect(() => {
    if (!selectedProject) return
    // 解決順（保存済み → 案件から計算）は resolveScoringWeights に一本化してある。
    // ここで別に書くと、画面に出す配点と実際に採点する配点がズレる
    setScoringWeights(resolveScoringWeights(selectedProject))
    // 契約形態が「派遣」なら派遣免許フィルターを自動ON
    setRequireHaken(selectedProject.contract_type === '派遣')
    // 案件を切り替えたら取得件数を初期値へ（次の案件で前の展開状態を引き継がない）
    setRankFetchLimit(RANK_FETCH_INITIAL)
  }, [selectedProject?.id]) // selectedProject?.id: プロジェクトが非同期ロードされた後も再発火させるため

  // メモ化必須: 毎レンダリング新しい配列を作ると、これを依存に持つ useMemo / useQuery が
  // 毎回走り直して重複検索を取り直してしまう
  const selectedProjectRanked = useMemo(
    () => (selectedProject ? toRankedForProject(sortedSelectedProjectSubs, rankingCandidates) : []),
    [selectedProject?.id, sortedSelectedProjectSubs, rankingCandidates],
  )
  const selectedCandidateSubs = sortedSelectedCandidateSubs

  // 必須スキルが満たされているかの判定はサーバ（skill_satisfies）に問い合わせる。
  // 画面側で部分一致すると、配点に入っていないスキルが緑で出てしまう
  const selectedProjectSkillNeeds = useMemo(() => {
    if (!selectedProject) return { have: [] as string[], want: [] as string[] }
    const want = [
      ...((selectedProject.required_skills as string[] | null) ?? []),
      ...(((selectedProject.raw_data as Record<string, unknown>)?.niceToHaveSkills as string[] | null) ?? []),
    ]
    const have = selectedProjectRanked.flatMap(s => (s.candidate.skills as string[] | null) ?? [])
    return { have: [...new Set(have)], want: [...new Set(want)] }
  }, [selectedProject?.id, selectedProjectRanked.length])

  const { data: projectSkillMatcher = NO_MATCHES } = useQuery({
    queryKey: [
      'matching-skill-matches',
      selectedProject?.id,
      selectedProjectSkillNeeds.have.length,
      selectedProjectSkillNeeds.want.join(','),
    ],
    queryFn: () => fetchSkillMatches(selectedProjectSkillNeeds.have, selectedProjectSkillNeeds.want),
    enabled: mode === 'project'
      && selectedProjectSkillNeeds.have.length > 0
      && selectedProjectSkillNeeds.want.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  // 重複候補マップ: candidate_id → DuplicateCandidate[]
  //
  // 以前は上位100人ぶんの RPC を useEffect から並列で叩いていた（100往復・12MB・
  // React Query の外なのでキャッシュも効かず、案件を切り替えるたびに再取得していた）。
  // 1本の batch RPC に置き換え、useQuery に載せてキャッシュを効かせる。
  // 対象は上位100件のまま（それ以下は画面に重複バッジを出していない）。
  // ランキングの総数。stats（submission_counts RPC）は画面表示時に既に読んでいるので
  // ここで数えるための追加クエリは要らない。取得済み件数より大きいのが普通
  const projectRankTotal = selectedProjectId
    ? (stats?.countByProjectId[selectedProjectId] ?? selectedProjectRanked.length)
    : 0

  // 引いた分だけを対象にする（未展開なら20人分）。上限100は据え置き
  const duplicateTargetIds = useMemo(
    () => selectedProjectRanked.slice(0, 100).map((s) => s.candidate.id),
    [selectedProjectRanked],
  )
  const duplicateTargetKey = duplicateTargetIds.join(',')

  const { data: duplicateRowsBySource = EMPTY_DUPLICATE_ROWS } = useQuery({
    queryKey: ['matching-duplicates', dataEnv, selectedProjectId, duplicateTargetKey],
    queryFn: () => findDuplicateCandidatesBatch(duplicateTargetIds, dataEnv),
    enabled: mode === 'project' && !!selectedProjectId && duplicateTargetIds.length > 0,
  })

  // スコアリングと「明らかに別人」の除外は取得と切り離す（再取得なしで再計算できる）
  const duplicatesMap = useMemo(() => {
    const map: Record<string, DuplicateCandidate[]> = {}
    for (const s of selectedProjectRanked) {
      const rows = duplicateRowsBySource[s.candidate.id]
      if (!rows) continue
      map[s.candidate.id] = rows
        .map((d) => ({ ...d, duplicateScore: calcDuplicateScore(d, s.candidate) }))
        .filter((d) => d.duplicateScore >= 50)
        .sort((a, b) => b.duplicateScore - a.duplicateScore)
    }
    return map
  }, [duplicateRowsBySource, selectedProjectRanked])

  const busy =
    matchByProjectMutation.isPending ||
    matchByCandidateMutation.isPending ||
    bulkAllProjectsMutation.isPending ||
    bulkAllCandidatesMutation.isPending

  const runBulkAllProjects = () => {
    const plist = projects as Project[]
    // 人数は件数クエリから取る（一覧は50件しか引いていない）
    if (plist.length === 0 || candidateCount === 0) return
    const maxCalls =
      matchingRunMode === 'full'
        ? plist.length * candidateCount
        : plist.length * BATCH_TOP_N
    if (
      !window.confirm(
        matchingRunMode === 'full'
          ? `募集中の全 ${plist.length} 案件について、登録済みの全 ${candidateCount} 名と AI マッチングを再実行します。\nAPI 呼び出しは最大 ${maxCalls} 回です。よろしいですか？`
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
    // 一覧は50件しか引いていないので、件数は件数クエリから。
    // 実際の対象人材はミューテーション側で全件取得する
    if (plist.length === 0 || candidateCount === 0) return
    const maxCalls =
      matchingRunMode === 'full'
        ? plist.length * candidateCount
        : candidateCount * fastMaxProjects
    if (
      !window.confirm(
        matchingRunMode === 'full'
          ? `全 ${candidateCount} 名の人材について、募集中の全 ${plist.length} 案件と AI マッチングを再実行します。\nAPI 呼び出しは最大 ${maxCalls} 回です。よろしいですか？`
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

      {/* 派遣免許フィルター */}
      {mode === 'project' && selectedProject && (
        <div className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 ${requireHaken ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-gray-800 shrink-0">派遣免許確認済みのみ</span>
            {selectedProject.contract_type === '派遣' && !requireHaken && (
              <span className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5">この案件は派遣契約です</span>
            )}
            {requireHaken && (
              <span className="text-xs text-blue-600">派遣許可番号が確認済みの会社の人材のみ対象</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setRequireHaken(v => !v)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${requireHaken ? 'bg-blue-600' : 'bg-gray-200'}`}
          >
            <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 ${requireHaken ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      )}

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
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => setScoringWeights({ ...DEFAULT_SCORING_WEIGHTS })}
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1 transition-colors"
              >
                <RotateCcw size={11} />標準
              </button>
              <button
                type="button"
                onClick={() => setScoringWeights({ skill: 30, exp: 10, rate: 10, location: 40, remote: 10 })}
                className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-1 transition-colors"
                title="大阪・地方案件など勤務地を重視する場合"
              >
                📍 地域重視
              </button>
              <button
                type="button"
                onClick={() => setScoringWeights({ skill: 55, exp: 15, rate: 15, location: 10, remote: 5 })}
                className="inline-flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 border border-purple-200 rounded px-2 py-1 transition-colors"
                title="スキルの一致度を最優先する場合"
              >
                🔧 スキル重視
              </button>
            </div>
            {mode === 'project' && selectedProject && (
              <button
                type="button"
                disabled={savingWeights}
                onClick={async () => {
                  setSavingWeights(true)
                  try {
                    await saveProjectMatchWeights(
                      selectedProject.id,
                      dataEnv,
                      scoringWeights as Record<string, number>,
                      (selectedProject.raw_data ?? {}) as Record<string, unknown>,
                    )
                    queryClient.invalidateQueries({ queryKey: projectsQueryKeys.open(dataEnv) })
                    setMessage({ type: 'success', text: 'この案件にウェイトを保存しました' })
                  } catch (e) {
                    setMessage({ type: 'error', text: String(e) })
                  } finally {
                    setSavingWeights(false)
                  }
                }}
                className="w-full mt-1 inline-flex items-center justify-center gap-1.5 text-xs bg-green-600 text-white rounded px-3 py-1.5 hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {savingWeights ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                この案件に保存
              </button>
            )}
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
                disabled={projectList.length === 0 || candidateCount === 0 || busy}
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
                  const nAi = aiCountByProject[p.id] ?? 0
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
                        <div className="text-sm font-medium text-gray-800 truncate flex items-center gap-1">
                          {p.title}
                          {!!((p.raw_data as Record<string, unknown>)?.matchWeights) && (
                            <span className="text-[10px] bg-green-100 text-green-700 rounded px-1 shrink-0">⚖ カスタム</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs mt-0.5 flex-wrap">
                          {p.client && <span className="text-gray-400 truncate">{p.client}</span>}
                          {isBusy ? (
                            <span className="flex items-center gap-1 text-blue-600">
                              <Loader2 size={11} className="animate-spin" />実行中
                            </span>
                          ) : n === 0 ? (
                            <span className="text-amber-600">未実施</span>
                          ) : n !== null ? (
                            <span
                              className="text-gray-400"
                              title="保存済みのスコア件数です。AI が採点・理由付けしたのはうち上位の数名だけで、残りはルールスコアのみです"
                            >
                              保存済み {n}件（AI採点 {nAi}件）
                            </span>
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
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
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
                          disabled={candidateCount === 0 || busy}
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
                      {(() => {
                        const req = (selectedProject.required_skills as string[] | null) ?? []
                        const nice = ((selectedProject.raw_data as Record<string, unknown>)?.niceToHaveSkills as string[] | null) ?? []
                        const ai = getAiInterpretation(selectedProject.raw_data)
                        const aiSkills = aiRelatedSkillMap(selectedProject.raw_data)
                        if (req.length === 0 && nice.length === 0 && !ai?.multiPerson && !ai?.requiredRole) return null
                        return (
                          <div className="flex flex-wrap gap-1">
                            {/* 求める役割。順位に加減点で効いているので、根拠つきで画面に出す
                                （2026-08-13 指摘「判定に使った情報は出さないと本当か？となる」） */}
                            {ai?.requiredRole && (
                              <span
                                className="px-1.5 py-0.5 bg-amber-50 border border-amber-300 text-amber-800 rounded text-xs font-medium"
                                title={`AIの解釈: この案件は${ai.requiredRole}を求めている${ai.roleReason ? `（${ai.roleReason}）` : ''}\n役割が近い人を加点、畑違いを減点します`}
                              >
                                役割: {ai.requiredRole} <span className="opacity-60">AI解釈</span>
                              </span>
                            )}
                            {req.slice(0, 10).map(s => (
                              <span key={s} className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-medium text-xs">{s}</span>
                            ))}
                            {req.length > 10 && (
                              <span className="text-gray-400 text-xs">+{req.length - 10}</span>
                            )}
                            {nice.map(s => aiSkills.has(s.trim().toLowerCase())
                              ? (
                                <span key={s} title={`AIの解釈: ${aiSkills.get(s.trim().toLowerCase()) ?? '業務内容から読める関連スキル'}`}
                                  className="px-1.5 py-0.5 bg-violet-50 text-violet-700 border border-dashed border-violet-300 rounded text-xs">
                                  {s}<span className="opacity-60 ml-0.5">AI</span>
                                </span>
                              )
                              : <span key={s} className="px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded text-xs">{s}</span>)}
                            {ai?.multiPerson && (
                              <span
                                className="px-1.5 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded text-xs"
                                title={`AIの解釈: チーム全体でスキル要件を満たせばよい案件${ai.evidence ? `（本文:「${ai.evidence}」）` : ''}`}
                              >
                                複数名で補完可 <span className="opacity-60">AI解釈</span>
                              </span>
                            )}
                          </div>
                        )
                      })()}
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
                    {/* 順位を見ている画面で「なぜこの順なのか」が分かるように、
                        案件画面と同じ配点表・スキルの重みをここにも出す（2026-08-13 指摘）。
                        ウェイトは調整中の scoringWeights を渡す＝実際に採点している値そのもの */}
                    <MatchingInputs
                      project={selectedProject}
                      requiredSkillCount={((selectedProject.required_skills as string[] | null) ?? []).length}
                      niceCount={(((selectedProject.raw_data as Record<string, unknown>)?.niceToHaveSkills as string[] | null) ?? []).length}
                      weights={scoringWeights}
                      compact
                    />
                    {matchByProjectMutation.isPending && matchByProjectMutation.variables === selectedProject.id && matchRunProgress && (
                      <p className="text-xs text-blue-700 bg-blue-50 rounded px-3 py-2">
                        {formatMatchRunProgressLine(matchRunProgress)}
                      </p>
                    )}
                    {isLoadingProjectSubs || isLoadingRankingCandidates ? (
                      <p className="text-sm text-gray-400">読み込み中...</p>
                    ) : selectedProjectRanked.length === 0 ? (
                      <p className="text-sm text-gray-500">マッチング未実施、または「再実行」で算出してください。</p>
                    ) : (
                      <div className="space-y-3">
                        {/* 「AI 判定です」と一律に書いていたが、AI が見るのは上位N名だけ。
                            残りはルールスコアのみなので、内訳を出して区別できるようにする */}
                        {/* 全件数は submission_counts（既に読んでいる stats）から取る。
                            ランキング本体は上位20件しか引いていないので length では総数にならない */}
                        <p className="text-xs font-medium text-gray-500">
                          マッチングランキング（全 {projectRankTotal} 名
                          {(() => {
                            const ai = selectedProjectRanked.filter(s => s.ai_summary).length
                            return `：うち取得済み ${selectedProjectRanked.length} 名・AI採点 ${ai} 名`
                          })()}
                          ）
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
                              niceToHaveSkills={(selectedProject.raw_data as Record<string, unknown>)?.niceToHaveSkills as string[] ?? []}
                              aiNiceSkills={aiRelatedSkillMap(selectedProject.raw_data)}
                              specialist={getAiInterpretation(selectedProject.raw_data)?.specialist}
                              requiredRole={getAiInterpretation(selectedProject.raw_data)?.requiredRole}
                              skillMatcher={projectSkillMatcher}
                              agentDomainMap={agentDomainMap}
                            />
                          ))}
                          <RankingRestAccordion
                            count={Math.min(projectRankTotal, RANK_FETCH_MAX) - RANK_HEAD}
                            unitLabel="名"
                            remaining={Math.min(projectRankTotal, RANK_FETCH_MAX) - selectedProjectRanked.length}
                            onLoadMore={() => setRankFetchLimit((n) => Math.min(n + RANK_FETCH_STEP, RANK_FETCH_MAX))}
                            loading={isFetchingProjectSubs}
                          >
                            {selectedProjectRanked.slice(RANK_HEAD).map((s, idx) => (
                              <ProjectModeRankCard
                                key={s.id}
                                s={s}
                                rankIndex={RANK_HEAD + idx}
                                onOpenCandidateDetail={onOpenCandidateDetail}
                                scoreColor={scoreColor}
                                onDecide={(sub) => decideMutation.mutate(sub)}
                                // 6位以降にも同一人物候補を出す（2026-08-20）。
                                // 上位5枚にしか渡しておらず、アコーディオンを開いても気づけなかった。
                                // duplicatesMap は取得済みなので通信は増えない
                                duplicates={duplicatesMap[s.candidate.id]}
                                requiredSkills={selectedProject.required_skills as string[]}
                                niceToHaveSkills={(selectedProject.raw_data as Record<string, unknown>)?.niceToHaveSkills as string[] ?? []}
                                aiNiceSkills={aiRelatedSkillMap(selectedProject.raw_data)}
                              specialist={getAiInterpretation(selectedProject.raw_data)?.specialist}
                              requiredRole={getAiInterpretation(selectedProject.raw_data)?.requiredRole}
                                agentDomainMap={agentDomainMap}
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
                disabled={projectList.length === 0 || candidateCount === 0 || busy}
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

          {candidateCount === 0 && !isLoadingCandidates ? (
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
                    {/* ★のみ表示（端末ごとの設定。星そのものはチーム共有） */}
                    <button
                      type="button"
                      onClick={() => {
                        const next = !bookmarkOnly
                        setBookmarkOnly(next)
                        writeBookmarkOnly('matching', next)
                        setSelectedCandidateId(null)
                        setCandidateDisplayLimit(50)
                      }}
                      className={`flex items-center gap-1 px-2.5 py-1.5 md:py-0.5 text-xs rounded font-medium transition-colors ${
                        bookmarkOnly ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                      title={bookmarkOnly ? 'ブックマークの絞り込みを外す' : 'ブックマークした人材だけを表示する'}
                    >
                      <Star size={12} fill={bookmarkOnly ? 'currentColor' : 'none'} />
                      ★のみ
                    </button>
                    {searchQuery && (
                      <span className="ml-auto text-xs text-gray-400 self-center">{candidateCount}件</span>
                    )}
                  </div>
                </div>
                <div className="overflow-y-auto md:max-h-[588px]">
                {filteredCandidateList.length === 0 ? (
                  <p className="text-xs text-gray-400 px-3 py-4">該当する人材がありません。</p>
                ) : filteredCandidateList.map((c) => {
                  const n = isLoadingStats ? null : (countByCandidate[c.id] ?? 0)
                  const nAi = aiCountByCandidate[c.id] ?? 0
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
                      <BookmarkStar candidateId={c.id} dataEnv={dataEnv} bookmarked={c.bookmarked === true} />
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
                            <span
                              className="text-gray-400"
                              title="保存済みのスコア件数です。AI が採点・理由付けしたのはうち上位の数名だけで、残りはルールスコアのみです"
                            >
                              保存済み {n}件（AI採点 {nAi}件）
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {isSelected && <ChevronRight size={14} className="text-blue-400 shrink-0" />}
                    </div>
                  )
                })}
                {/* 残り件数はサーバーの件数クエリから。押すと次の50件をサーバーから追加で引く */}
                {candidateCount > filteredCandidateList.length && (
                  <button
                    type="button"
                    onClick={() => setCandidateDisplayLimit(n => n + 50)}
                    disabled={isLoadingCandidates}
                    className="w-full py-2 text-xs text-blue-600 hover:bg-blue-50 border-t border-gray-100 disabled:opacity-50"
                  >
                    もっと見る（残り{candidateCount - filteredCandidateList.length}件）
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
                    {/* ヘッダー: 名前・タグ・ボタン群（CandidatePage の右パネルと同等） */}
                    {(() => {
                      const rp = selectedCandidate.raw_profile as Record<string, unknown>
                      const from = rp?.from as string | null
                      const rawText = rp?.text as string | null
                      const subject = rp?.subject as string | null
                      const receivedAt = rp?.emailReceivedAt as string | null
                      const desiredRate = (selectedCandidate as unknown as { desired_rate?: string }).desired_rate
                      const fromCompany = (selectedCandidate as unknown as { from_company?: string }).from_company
                      const resumeLink = selectedCandidate.drive_url || selectedCandidate.resume_url || (() => {
                        const m = (rawText ?? '').match(/https:\/\/drive\.google\.com\/[^\s"'<>\]）]+/)
                        return m ? m[0] : null
                      })()
                      return (
                        <>
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0">
                              <h3 className="text-base font-semibold text-gray-800 break-words">{selectedCandidate.name}</h3>
                              <div className="flex flex-wrap gap-2 mt-1">
                                {fromCompany && (
                                  <span className="text-xs text-gray-500 bg-gray-100 rounded px-2 py-0.5">{fromCompany}</span>
                                )}
                                {desiredRate && (
                                  <span className="text-xs text-green-700 bg-green-50 rounded px-2 py-0.5 font-medium">{desiredRate}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              {resumeLink && (
                                <a href={toViewerUrl(resumeLink)} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-blue-200 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors">
                                  <ExternalLink size={13} />経歴書
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
                                  <a href={`mailto:${from}?subject=${reSubject}&body=${quoted}`}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                                    title="返信（元メール引用）">
                                    <Reply size={13} />返信
                                  </a>
                                )
                              })()}
                              {onOpenCandidateDetail && (
                                <button type="button"
                                  onClick={() => onOpenCandidateDetail(selectedCandidate.id)}
                                  className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors">
                                  詳細ページ
                                </button>
                              )}
                              <button type="button"
                                onClick={() => { setMessage(null); matchByCandidateMutation.mutate(selectedCandidate.id) }}
                                disabled={projectList.length === 0 || busy}
                                className="inline-flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                                {matchByCandidateMutation.isPending && matchByCandidateMutation.variables === selectedCandidate.id
                                  ? <Loader2 size={13} className="animate-spin" />
                                  : <RefreshCw size={13} />}
                                再実行
                              </button>
                            </div>
                          </div>

                          {/* プロフィール詳細（CandidatePage 右パネルと同等） */}
                          <CandidateProfileFields c={selectedCandidate} isExpanded detailMode />

                          {/* 元メール本文 */}
                          {rawText?.trim() && (
                            <details className="border border-gray-200 rounded-lg">
                              <summary className="px-3 py-2 text-xs font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-50 rounded-lg">
                                元メール本文
                              </summary>
                              <div className="px-3 pb-3 pt-1">
                                {subject && <p className="text-xs text-gray-400 mb-1">件名: {subject}</p>}
                                {from && <p className="text-xs text-gray-400 mb-2">差出人: {from}</p>}
                                <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed bg-gray-50 rounded p-2 max-h-96 overflow-y-auto">
                                  {rawText}
                                </pre>
                              </div>
                            </details>
                          )}
                        </>
                      )
                    })()}

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
