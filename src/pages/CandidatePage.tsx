import { useState, useRef, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query'
import { Loader2, UserPlus, RefreshCw, Trash2, ChevronDown, ChevronUp, MapPin, Wifi, SlidersHorizontal, Mail, Pencil, X, Paperclip, ChevronRight, ExternalLink, Reply, Map as MapIcon } from 'lucide-react'
import { toViewerUrl } from '../lib/viewerUrl'
import { updateCandidate, fetchCandidatesPage, fetchCandidateCount, filterCandidates, filterCandidateCount, deleteCandidate, fetchCandidateRawProfile } from '../lib/db/candidates'
import type { CandidateFilter, SkillYearFilter } from '../lib/db/candidates'
import { supabase } from '../lib/supabase'
import { getIsImportActive } from '../lib/db/emailSettings'
import type { Candidate } from '../lib/db/candidates'
import { fetchAgentDomainMap } from '../lib/db/agentCompanies'
import { AgentCompaniesModal } from '../components/AgentCompaniesModal'
import type { AgentCompany } from '../lib/db/agentCompanies'
import type { DataEnv } from '../lib/dataEnv'
import { DemoSeedPanel } from '../components/DemoSeedPanel'
import { DemoMatchingTestPanel } from '../components/DemoMatchingTestPanel'
import { extractTextFromExcel, extractTextFromWord, getFileCategory } from '../lib/fileParser'
import { findSkillMonths } from '../lib/skillYearsMatch'

interface SkillsByCategory {
  languages: string[]
  frameworks: string[]
  libraries: string[]
  os: string[]
  databases: string[]
  dwh: string[]
  clouds: string[]
  infrastructures: string[]
  tools: string[]
  methodologies: string[]
  certifications: string[]
  design: string[]
  marketing: string[]
  others: string[]
}

interface RawProfile {
  skillsByCategory?: SkillsByCategory
  roles?: string[]
  industries?: string[]
  prefecture?: string | null
  nearestStation?: string | null
  availableRegions?: string[] | null
  currentWorkLocation?: string | null
  remoteAvailable?: boolean
  from?: string | null
  subject?: string | null
  summary?: string | null
  text?: string | null
  emailReceivedAt?: string | null
  age?: number | null
  gender?: string | null
  agentComment?: string | null
  selfPR?: string | null
  skillYears?: Record<string, number> | null
}

function getRaw(c: Candidate): RawProfile {
  return (c.raw_profile ?? {}) as RawProfile
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

/** 登録直後で常駐AIの校正（llm-overwrite）がまだ通っていないと推定される場合 true。
 * AI校正やBox取込等の更新が入ると updated_at が created_at から離れることを利用する。
 * 「変更なし」で完了したケースは updated_at が動かないため、60分経過で自動的に消す
 * （平均校正レイテンシは約20分・最大約1時間の実測に基づく。2026-08-10） */
function isAiCorrectionPending(c: { created_at: string; updated_at: string }): boolean {
  const created = new Date(c.created_at).getTime()
  const updated = new Date(c.updated_at).getTime()
  return Date.now() - created < 60 * 60 * 1000 && updated - created < 10_000
}

const CATEGORY_STYLE: Record<keyof SkillsByCategory, { label: string; badge: string }> = {
  languages:       { label: '言語',       badge: 'bg-blue-50 text-blue-700' },
  frameworks:      { label: 'FW',         badge: 'bg-green-50 text-green-700' },
  libraries:       { label: 'ライブラリ', badge: 'bg-emerald-50 text-emerald-700' },
  os:              { label: 'OS',         badge: 'bg-amber-50 text-amber-700' },
  databases:       { label: 'DB',         badge: 'bg-orange-50 text-orange-700' },
  dwh:             { label: 'DWH',        badge: 'bg-fuchsia-50 text-fuchsia-700' },
  clouds:          { label: 'クラウド',   badge: 'bg-sky-50 text-sky-700' },
  infrastructures: { label: 'インフラ',   badge: 'bg-cyan-50 text-cyan-700' },
  tools:           { label: 'ツール',     badge: 'bg-violet-50 text-violet-700' },
  methodologies:   { label: '手法',       badge: 'bg-indigo-50 text-indigo-700' },
  certifications:  { label: '資格',       badge: 'bg-yellow-50 text-yellow-700' },
  design:          { label: 'デザイン',   badge: 'bg-pink-50 text-pink-700' },
  marketing:       { label: 'マーケ',     badge: 'bg-rose-50 text-rose-700' },
  others:          { label: 'その他',     badge: 'bg-gray-100 text-gray-600' },
}

const CATEGORY_KEYS = Object.keys(CATEGORY_STYLE) as (keyof SkillsByCategory)[]

// カテゴリごとの折りたたみ閾値
const COLLAPSED_PER_CATEGORY = 5

// 47都道府県リスト（フィルターポップアップのドロップダウンに使用）
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]

interface FilterDraft {
  name: string
  skillInput: string
  skills: string[]
  skillYearFilters: SkillYearFilter[]
  prefecture: string
  expMin: string
}

const EMPTY_DRAFT: FilterDraft = { name: '', skillInput: '', skills: [], skillYearFilters: [], prefecture: '', expMin: '' }

/** "Java 10年" / "Java10年以上" → {skill:"Java", minYears:10} に変換。マッチしなければ null */
function parseSkillYear(input: string): SkillYearFilter | null {
  const m = input.trim().match(/^(.+?)\s*(\d+)\s*年(?:以上)?$/)
  if (!m) return null
  const skill = m[1].trim()
  const minYears = parseInt(m[2], 10)
  if (!skill || minYears <= 0 || minYears > 50) return null
  return { skill, minYears }
}

/**
 * スキル重要度スコアを計算する（raw_profile.text をもとに）
 * - 出現回数が多いほど高スコア
 * - 「希望・得意・専門・強み・メイン・注力」の近傍（±30字）にあると +2
 * - 本文の前半 500 字以内に登場すると +1（冒頭に書く = 推しスキル）
 */
function computeSkillScores(skills: string[], rawText: string): Map<string, number> {
  const scores = new Map<string, number>()
  if (!rawText) {
    for (const s of skills) scores.set(s, 0)
    return scores
  }
  const lowerText = rawText.toLowerCase()
  const EMPHASIS_RE = /希望|得意|専門|強み|メイン|主に|中心|注力|推し|自信/

  for (const skill of skills) {
    const lowerSkill = skill.toLowerCase()
    let count = 0
    let firstPos = Infinity
    let bonus = 0
    let idx = 0

    while ((idx = lowerText.indexOf(lowerSkill, idx)) !== -1) {
      if (count === 0) firstPos = idx
      count++
      const ctx = lowerText.slice(Math.max(0, idx - 30), idx + lowerSkill.length + 30)
      if (EMPHASIS_RE.test(ctx)) bonus += 2
      idx += lowerSkill.length
    }

    const posScore = firstPos < 500 ? 1 : 0
    scores.set(skill, count + bonus + posScore)
  }
  return scores
}
// カード全体の折りたたみ表示を出す最低スキル合計数
const EXPAND_THRESHOLD = 10

// ---- 編集フォーム用の状態型 ----
interface EditForm {
  name: string
  email: string
  phone: string
  experience_years: string
  duplicate_flag: boolean
  summary: string
  roles: string          // 改行区切り
  industries: string     // 改行区切り
  prefecture: string
  nearestStation: string
  currentWorkLocation: string
  availableRegions: string // 改行区切り
  remoteAvailable: boolean
  subject: string
  from: string           // 読み取り専用
  skills: Record<keyof SkillsByCategory, string> // カンマ区切り
}

function toEditForm(c: Candidate): EditForm {
  const raw = getRaw(c)
  const sbc = raw.skillsByCategory ?? ({} as SkillsByCategory)
  const skills = {} as Record<keyof SkillsByCategory, string>
  for (const key of CATEGORY_KEYS) {
    skills[key] = (sbc[key] ?? []).join(', ')
  }
  return {
    name: c.name ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    experience_years: c.experience_years != null ? String(c.experience_years) : '',
    duplicate_flag: c.duplicate_flag ?? false,
    summary: raw.summary ?? '',
    roles: (raw.roles ?? []).join('\n'),
    industries: (raw.industries ?? []).join('\n'),
    prefecture: raw.prefecture ?? '',
    nearestStation: raw.nearestStation ?? '',
    currentWorkLocation: raw.currentWorkLocation ?? '',
    availableRegions: (raw.availableRegions ?? []).join('\n'),
    remoteAvailable: raw.remoteAvailable ?? false,
    subject: raw.subject ?? '',
    from: raw.from ?? '',
    skills,
  }
}

function splitLines(s: string): string[] {
  return s.split('\n').map(x => x.trim()).filter(Boolean)
}
function splitComma(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

// ---- プロフィール表示（一覧カード・詳細画面で共用） ----
export function CandidateProfileFields({
  c,
  isExpanded,
  onToggleExpand,
  detailMode = false,
  agentDomainMap,
}: {
  c: Candidate
  isExpanded: boolean
  onToggleExpand?: () => void
  /** true のとき常に全表示（詳細画面） */
  detailMode?: boolean
  agentDomainMap?: Map<string, AgentCompany>
}) {
  const raw = getRaw(c)
  const { skillsByCategory: sbc, roles, industries,
    prefecture, nearestStation, availableRegions,
    currentWorkLocation, remoteAvailable,
    from: mailFrom, subject: mailSubject, emailReceivedAt,
    age, gender, agentComment, selfPR, skillYears, nationality } = raw as typeof raw & { nationality?: string | null }
  const employmentType = (raw as Record<string, unknown>).employmentType as string | null | undefined
  const commercialFlow = (raw as Record<string, unknown>).commercialFlow as string | null | undefined
  const emailDomain = mailFrom ? mailFrom.split('@')[1]?.toLowerCase().trim() : null
  const agentInfo = emailDomain && agentDomainMap ? agentDomainMap.get(emailDomain) : null

  function getSkillMonths(skill: string): number | null {
    return findSkillMonths(skillYears, skill)
  }

  function monthsToLabel(months: number): string {
    if (months < 12) return '〜1年'
    return `${Math.floor(months / 12)}年`
  }

  const rawText = raw.text ?? ''

  const totalSkills = sbc
    ? Object.values(sbc).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
    : (c.skills as string[]).length

  // スキルスコア（出現回数・強調コンテキスト・前半登場ボーナス）
  const allSkillNames = sbc
    ? (Object.values(sbc) as string[][]).flat()
    : (c.skills as string[])
  const skillScores = useMemo(
    () => computeSkillScores(allSkillNames, rawText),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c.id, rawText],
  )
  const needsToggle = !detailMode && totalSkills > EXPAND_THRESHOLD
  const showAll = detailMode || isExpanded

  const hasLocation = prefecture || nearestStation || currentWorkLocation ||
    (availableRegions && availableRegions.length > 0) || remoteAvailable

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-gray-800 text-sm">{c.name}</span>
        {c.duplicate_flag && (
          <span className="text-xs bg-yellow-100 text-yellow-700 rounded px-2 py-0.5">重複の疑い</span>
        )}
        {isAiCorrectionPending(c) && (
          <span
            className="text-xs bg-sky-50 text-sky-600 border border-sky-200 rounded px-2 py-0.5 animate-pulse"
            title="登録直後です。常駐AIが本文・経歴書を読み直して項目を補正します（平均20分以内）"
          >
            ✨ AI校正中
          </span>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-0.5">
        {c.email ?? 'メールなし'} ／ 経験{c.experience_years ?? '?'}年{age != null ? ` ／ ${age}歳` : ''}{gender ? `（${gender}）` : ''}{nationality ? ` ／ ${nationality}` : ''}
      </p>
      {(c.from_company || employmentType || commercialFlow) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          {c.from_company && (
            <span className="flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
              🏢 {c.from_company}
            </span>
          )}
          {agentInfo?.haken_number && (
            <a
              // 同一許可番号でも複数事業所（本店・支店等）があり、詳細ページURL末尾の
              // 事業所インデックスは番号ごとに異なる（固定値では推測できない）。
              // haken_detail_url は verify-agent-license が検索結果ページから正しい
              // リンクを取得済みの場合に入る。未取得の場合のみ推測値（インデックス1）で
              // フォールバックする（外れる可能性がある）。
              href={agentInfo.haken_detail_url ?? `https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=${encodeURIComponent(agentInfo.haken_number + ',1     ')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs bg-green-50 text-green-700 rounded px-1.5 py-0.5 hover:bg-green-100 transition-colors"
              title="ハローワーク許可番号照会"
            >
              {agentInfo.haken_number}
            </a>
          )}
          {agentInfo?.license_status === 'none' && c.from_company && (
            <span className="text-xs bg-red-50 text-red-500 rounded px-1.5 py-0.5">許可未確認</span>
          )}
          {commercialFlow && (() => {
            // 商流バッジ: 「うちから紹介で客先常駐できるか」を色で一目化。
            // 自社=直接可(緑)／N社先=N社挟む(深いほど警戒色: 1社先=黄・2社先以上=赤)
            const num = Number(commercialFlow.match(/^(\d+)社先/)?.[1] ?? 0)
            const cls = commercialFlow === '自社'
              ? 'bg-emerald-100 text-emerald-800 font-medium'
              : num >= 2
                ? 'bg-red-100 text-red-700 font-medium'
                : 'bg-amber-100 text-amber-800 font-medium'
            return <span className={`text-xs rounded px-1.5 py-0.5 ${cls}`} title="商流位置（自社=直接紹介可 / N社先=N社を挟む）">{commercialFlow}</span>
          })()}
          {employmentType && (() => {
            // 雇用形態バッジ（縛りの種類）。商流バッジと役割が違うのでグレー系で控えめに
            const styles: Record<string, string> = {
              '正社員': 'bg-slate-100 text-slate-700',
              '契約社員': 'bg-purple-50 text-purple-700',
              '派遣社員': 'bg-orange-50 text-orange-700',
              'フリーランス': 'bg-sky-50 text-sky-700',
              '業務委託': 'bg-teal-50 text-teal-700',
            }
            const cls = styles[employmentType] ?? 'bg-gray-50 text-gray-600'
            return <span className={`text-xs rounded px-1.5 py-0.5 ${cls}`}>{employmentType}</span>
          })()}
        </div>
      )}

      {hasLocation && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5">
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <MapPin size={11} />
            {[currentWorkLocation ?? prefecture, nearestStation].filter(Boolean).join(' / ')}
          </span>
          {availableRegions && availableRegions.length > 0 && (
            <span className="text-xs text-gray-400">
              対応: {availableRegions.join('・')}
            </span>
          )}
          {(() => {
            // 常駐可否タグ（システム判定のヒント）＋本文フレーズ（ホバーで全文）。
            // タグは目安。判断材料の生フレーズをtitleに必ず併記して人が正せるようにする。
            const tag = (raw as Record<string, unknown>).workStyleTag as string | null | undefined
            const note = (raw as Record<string, unknown>).workStyleNote as string | null | undefined
            // 旧データ（未移行）フォールバック
            const rws = (raw as Record<string, unknown>).remoteWorkStyle as string | null | undefined
            const label = tag ?? (rws && rws !== 'リモート可' ? rws : null)
            if (!label) return null
            const cls = label === '常駐可'
              ? 'bg-emerald-100 text-emerald-800'
              : label === 'リモート希望'
                ? 'bg-rose-100 text-rose-700'
                : 'bg-amber-100 text-amber-800' // 併用可・その他
            return (
              <span
                className={`flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ${cls} font-medium`}
                title={note ? `本文: ${note}` : undefined}
              >
                <Wifi size={10} />{label}
                {note && <span className="hidden md:inline text-[10px] font-normal opacity-70 truncate max-w-[16rem]">（{note}）</span>}
              </span>
            )
          })()}
          {(raw as Record<string, unknown>).hakenOk === true && (
            <span className="text-xs bg-green-50 text-green-700 rounded px-1.5 py-0.5">派遣OK</span>
          )}
          {(raw as Record<string, unknown>).hakenOk === false && (
            <span className="text-xs bg-red-50 text-red-600 rounded px-1.5 py-0.5">派遣NG</span>
          )}
        </div>
      )}

      <div className="mt-1.5 border-t border-gray-50 pt-1.5 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
            <Mail size={10} />
            {emailReceivedAt
              ? <>受信: {formatDate(emailReceivedAt)} <span className="text-gray-300">/ 登録: {c.created_at ? formatDate(c.created_at) : '—'}</span></>
              : <>登録: {c.created_at ? formatDate(c.created_at) : '—'}</>
            }
          </span>
          {mailFrom && (
            <span className="text-xs text-gray-400 truncate max-w-xs" title={mailFrom}>
              転送: {mailFrom}
            </span>
          )}
          {mailSubject && (
            <span className="text-xs text-gray-400 truncate max-w-xs" title={mailSubject}>
              件名: {mailSubject}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-300">
          最終更新: {formatDate(c.updated_at)}
          {c.updated_by ? ` by ${c.updated_by}` : ''}
        </div>
      </div>

      <div className="space-y-1 mt-1.5">
        {(roles ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-xs text-gray-400 w-12 shrink-0">役割</span>
            {/* roles はスコア降順（inbound-email の scoreProseRoles）: 先頭=主役割を強調表示 */}
            {(roles ?? []).map((r, idx) => (
              <span
                key={r}
                className={idx === 0 && (roles ?? []).length > 1
                  ? 'text-xs bg-indigo-600 text-white font-medium rounded px-1.5 py-0.5'
                  : 'text-xs bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5'}
              >
                {r}
              </span>
            ))}
          </div>
        )}
        {(industries ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-xs text-gray-400 w-12 shrink-0">業界</span>
            {(showAll ? industries! : (industries ?? []).slice(0, COLLAPSED_PER_CATEGORY)).map((i) => (
              <span key={i} className="text-xs bg-teal-50 text-teal-700 rounded px-1.5 py-0.5">{i}</span>
            ))}
            {!showAll && (industries ?? []).length > COLLAPSED_PER_CATEGORY && (
              <span className="text-xs text-gray-400">+{(industries ?? []).length - COLLAPSED_PER_CATEGORY}</span>
            )}
          </div>
        )}

        {selfPR && (
          <div className="mt-1.5 rounded-md bg-blue-50 border border-blue-100 px-3 py-2">
            <p className="text-xs font-medium text-blue-700 mb-0.5">自己PR</p>
            <p className="text-xs text-blue-900 whitespace-pre-wrap leading-relaxed">{selfPR as string}</p>
          </div>
        )}
        {agentComment && (
          <div className="mt-1.5 rounded-md bg-amber-50 border border-amber-100 px-3 py-2">
            <p className="text-xs font-medium text-amber-700 mb-0.5">エージェントコメント</p>
            <p className="text-xs text-amber-900 whitespace-pre-wrap leading-relaxed">{agentComment}</p>
          </div>
        )}

        {sbc ? (
          (Object.keys(CATEGORY_STYLE) as (keyof SkillsByCategory)[]).map((key) => {
            const items = sbc[key]
            if (!items || items.length === 0) return null
            const { label, badge } = CATEGORY_STYLE[key]
            const sorted = [...items].sort(
              (a, b) => (skillScores.get(b) ?? 0) - (skillScores.get(a) ?? 0)
            )
            const shown = showAll ? sorted : sorted.slice(0, COLLAPSED_PER_CATEGORY)
            const hidden = items.length - COLLAPSED_PER_CATEGORY
            return (
              <div key={key} className="flex flex-wrap gap-1 items-center">
                <span className="text-xs text-gray-400 w-12 shrink-0">{label}</span>
                {shown.map((s) => {
                  const months = getSkillMonths(s)
                  return (
                    <span key={s} className={`text-xs rounded px-1.5 py-0.5 ${badge}`}>
                      {s}{months != null && months > 0 && <span className="opacity-60 ml-0.5">({monthsToLabel(months)})</span>}
                    </span>
                  )
                })}
                {!showAll && hidden > 0 && (
                  <span className="text-xs text-gray-400">+{hidden}</span>
                )}
              </div>
            )
          })
        ) : (
          <div className="flex flex-wrap gap-1">
            {(() => {
              const sorted = [...(c.skills as string[])].sort(
                (a, b) => (skillScores.get(b) ?? 0) - (skillScores.get(a) ?? 0)
              )
              return (showAll ? sorted : sorted.slice(0, COLLAPSED_PER_CATEGORY)).map((s) => {
                const months = getSkillMonths(s)
                return (
                  <span key={s} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
                    {s}{months != null && months > 0 && <span className="opacity-60 ml-0.5">({monthsToLabel(months)})</span>}
                  </span>
                )
              })
            })()}
            {!showAll && (c.skills as string[]).length > COLLAPSED_PER_CATEGORY && (
              <span className="text-xs text-gray-400">+{(c.skills as string[]).length - COLLAPSED_PER_CATEGORY}</span>
            )}
          </div>
        )}
      </div>

      {needsToggle && onToggleExpand && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          className="mt-2 flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 transition-colors"
        >
          {isExpanded
            ? <><ChevronUp size={13} />閉じる</>
            : <><ChevronDown size={13} />すべて表示（{totalSkills}件）</>
          }
        </button>
      )}
    </div>
  )
}

// ---- 編集モーダル ----
interface EditModalProps {
  candidate: Candidate
  nickname: string
  dataEnv: DataEnv
  onClose: () => void
  onSaved: () => void
}

export function CandidateEditModal({ candidate, nickname, dataEnv, onClose, onSaved }: EditModalProps) {
  const [form, setForm] = useState<EditForm>(() => toEditForm(candidate))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }
  function setSkill(key: keyof SkillsByCategory, value: string) {
    setForm(prev => ({ ...prev, skills: { ...prev.skills, [key]: value } }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const raw = getRaw(candidate)
      const skillsByCategory = {} as SkillsByCategory
      for (const key of CATEGORY_KEYS) {
        skillsByCategory[key] = splitComma(form.skills[key])
      }
      const allSkills = Object.values(skillsByCategory).flat()

      await updateCandidate({
        id: candidate.id,
        dataEnv,
        name: form.name.trim() || candidate.name,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        experience_years: form.experience_years !== '' ? Number(form.experience_years) : null,
        duplicate_flag: form.duplicate_flag,
        updated_by: nickname,
        raw_profile: {
          ...raw,
          summary: form.summary,
          roles: splitLines(form.roles),
          industries: splitLines(form.industries),
          prefecture: form.prefecture || null,
          nearestStation: form.nearestStation || null,
          currentWorkLocation: form.currentWorkLocation || null,
          availableRegions: splitLines(form.availableRegions),
          remoteAvailable: form.remoteAvailable,
          subject: form.subject || null,
          // from は書き換えない (raw.from をそのまま維持)
          skillsByCategory,
        },
      })
      // skills カラムも同期
      await import('../lib/supabase').then(({ supabase }) =>
        supabase.from('candidates').update({ skills: allSkills }).eq('id', candidate.id).eq('data_env', dataEnv),
      )
      onSaved()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
  const labelCls = 'text-xs font-medium text-gray-600'
  const readonlyCls = 'w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 text-gray-400 cursor-not-allowed'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8 px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-800">人材情報の編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[75vh] overflow-y-auto">

          {/* 基本情報 */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">基本情報</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>氏名 *</label>
                <input className={inputCls} value={form.name} onChange={e => setField('name', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>経験年数</label>
                <input className={inputCls} type="number" min={0} value={form.experience_years}
                  onChange={e => setField('experience_years', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>メールアドレス</label>
                <input className={inputCls} value={form.email} onChange={e => setField('email', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>電話番号</label>
                <input className={inputCls} value={form.phone} onChange={e => setField('phone', e.target.value)} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input id="dup_flag" type="checkbox" checked={form.duplicate_flag}
                onChange={e => setField('duplicate_flag', e.target.checked)}
                className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-400" />
              <label htmlFor="dup_flag" className="text-sm text-gray-600">重複の疑いフラグ</label>
            </div>
          </section>

          {/* AI要約 */}
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">AI要約</h3>
            <textarea className={inputCls} rows={3} value={form.summary}
              onChange={e => setField('summary', e.target.value)} />
          </section>

          {/* 役割・業界 */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">役割・業界</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>役割（1行1項目）</label>
                <textarea className={inputCls} rows={3} value={form.roles}
                  onChange={e => setField('roles', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>業界（1行1項目）</label>
                <textarea className={inputCls} rows={3} value={form.industries}
                  onChange={e => setField('industries', e.target.value)} />
              </div>
            </div>
          </section>

          {/* 勤務地 */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">勤務地情報</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>都道府県</label>
                <input className={inputCls} value={form.prefecture}
                  onChange={e => setField('prefecture', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>最寄り駅</label>
                <input className={inputCls} value={form.nearestStation}
                  onChange={e => setField('nearestStation', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>現在の就業場所</label>
                <input className={inputCls} value={form.currentWorkLocation}
                  onChange={e => setField('currentWorkLocation', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>対応可能エリア（1行1項目）</label>
                <textarea className={inputCls} rows={2} value={form.availableRegions}
                  onChange={e => setField('availableRegions', e.target.value)} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input id="remote" type="checkbox" checked={form.remoteAvailable}
                onChange={e => setField('remoteAvailable', e.target.checked)}
                className="rounded border-gray-300 text-blue-500 focus:ring-blue-400" />
              <label htmlFor="remote" className="text-sm text-gray-600">リモート可</label>
            </div>
          </section>

          {/* スキル */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">スキル（カンマ区切り）</h3>
            <div className="grid grid-cols-2 gap-3">
              {CATEGORY_KEYS.map(key => (
                <div key={key} className="space-y-1">
                  <label className={labelCls}>{CATEGORY_STYLE[key].label}</label>
                  <textarea className={inputCls} rows={2} value={form.skills[key]}
                    onChange={e => setSkill(key, e.target.value)} />
                </div>
              ))}
            </div>
          </section>

          {/* メール情報 */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">メール情報</h3>
            <div className="space-y-1">
              <label className={labelCls}>件名（変更不可）</label>
              <input className={readonlyCls} value={form.subject} readOnly />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>転送元メールアドレス（変更不可）</label>
              <input className={readonlyCls} value={form.from} readOnly />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>メール受信日時（変更不可）</label>
              <input className={readonlyCls} value={getRaw(candidate).emailReceivedAt ? formatDate(getRaw(candidate).emailReceivedAt!) : (candidate.created_at ? formatDate(candidate.created_at) : '')} readOnly />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>解析完了日時（変更不可）</label>
              <input className={readonlyCls} value={candidate.created_at ? formatDate(candidate.created_at) : ''} readOnly />
            </div>
          </section>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">
            キャンセル
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- メインページ ----
interface Props {
  nickname: string
  dataEnv: DataEnv
  demoUiEnabled?: boolean
  /** カードクリックで人材詳細へ（未指定時は遷移なし） */
  onOpenCandidateDetail?: (candidateId: string) => void
  /** 人材マップへ遷移 */
  onOpenHeatmap?: () => void
}

export function CandidatePage({ nickname, dataEnv, demoUiEnabled = false, onOpenCandidateDetail: _onOpenCandidateDetail, onOpenHeatmap }: Props) {
  const [showRegisterModal, setShowRegisterModal] = useState(false)
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [replayingId, setReplayingId] = useState<string | null>(null)
  const [replayMsg, setReplayMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [boxUploadingId, setBoxUploadingId] = useState<string | null>(null)
  const [boxUploadMsg, setBoxUploadMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const boxFileInputRef = useRef<HTMLInputElement>(null)
  const boxUploadTargetRef = useRef<Candidate | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showFilterPopup, setShowFilterPopup] = useState(false)
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(EMPTY_DRAFT)
  const [appliedFilter, setAppliedFilter] = useState<CandidateFilter>({})
  const [editingCandidate, setEditingCandidate] = useState<Candidate | null>(null)
  const [uploadedFileNames, setUploadedFileNames] = useState<string[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const savedScrollTop = useRef<number>(0)
  const queryClient = useQueryClient()

  // 詳細パネルを閉じた後にリストのスクロール位置を復元する (#80)
  useEffect(() => {
    if (selectedId === null && listScrollRef.current && savedScrollTop.current > 0) {
      const target = savedScrollTop.current
      requestAnimationFrame(() => {
        if (listScrollRef.current) listScrollRef.current.scrollTop = target
      })
    }
  }, [selectedId])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setFileLoading(true)
    setMessage(null)
    try {
      const newNames: string[] = []
      for (const file of files) {
        const category = getFileCategory(file)
        if (category === 'pdf') {
          setMessage({ type: 'error', text: `${file.name}：PDF はテキスト解析対象外です。テキストを手動で貼り付けてください` })
        } else if (category === 'excel') {
          const extracted = await extractTextFromExcel(file)
          setText((prev) => prev ? `${prev}\n\n${extracted}` : extracted)
          newNames.push(`${file.name}（テキスト抽出済み）`)
        } else if (category === 'word') {
          const extracted = await extractTextFromWord(file)
          setText((prev) => prev ? `${prev}\n\n${extracted}` : extracted)
          newNames.push(`${file.name}（テキスト抽出済み）`)
        } else if (category === 'image') {
          setMessage({ type: 'error', text: `${file.name}：画像はテキスト解析対象外です。テキストを手動で貼り付けてください` })
        } else {
          setMessage({ type: 'error', text: `${file.name} はExcel・Wordファイルを選択してください` })
        }
      }
      setUploadedFileNames((prev) => [...prev, ...newNames])
    } catch {
      setMessage({ type: 'error', text: 'ファイルの読み込みに失敗しました' })
    } finally {
      setFileLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function removeFile(index: number) {
    setUploadedFileNames((prev) => prev.filter((_, i) => i !== index))
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCandidate(id, dataEnv),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
      queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
      queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
      setDeletingId(null)
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
      setDeletingId(null)
    },
  })

  function handleDelete(c: Candidate) {
    if (!window.confirm(`「${c.name}」を削除しますか？この操作は元に戻せません。`)) return
    setDeletingId(c.id)
    deleteMutation.mutate(c.id)
  }

  async function handleReplay(c: Candidate) {
    const rawText = (c.raw_profile as RawProfile)?.text
    if (!rawText) {
      setReplayMsg({ id: c.id, text: 'メール本文（raw_profile.text）がないため再解析できません', ok: false })
      return
    }
    setReplayingId(c.id)
    setReplayMsg(null)
    try {
      const originalFrom = (c.raw_profile as RawProfile)?.from ?? `replay+${c.id}@demo.invalid`

      // resume_url が Storage URL（attachments バケット）ならファイルを fetch して添付として渡す
      const attachments: { data: string; mimeType: string; name: string }[] = []
      const resumeUrl = c.resume_url
      if (resumeUrl && resumeUrl.includes('/storage/v1/object/public/attachments/')) {
        try {
          const res = await fetch(resumeUrl)
          if (res.ok) {
            const buf = await res.arrayBuffer()
            const bytes = new Uint8Array(buf)
            let binary = ''
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
            }
            const b64 = btoa(binary)
            const mimeType = res.headers.get('content-type') ?? 'application/octet-stream'
            const name = resumeUrl.split('/').pop() ?? 'attachment'
            attachments.push({ data: b64, mimeType, name })
          }
        } catch (e) {
          console.warn('添付ファイル取得失敗:', e)
        }
      }

      const { error } = await supabase.functions.invoke('inbound-email', {
        body: {
          subject: (c.raw_profile as RawProfile)?.subject ?? `【再解析】${c.name}`,
          body: rawText,
          from: originalFrom,
          attachments,
          mode: dataEnv,
          type: 'candidate',
          force: true,
          target_candidate_id: c.id,
        },
      })
      if (error) throw error
      const attachMsg = attachments.length > 0 ? `（添付${attachments.length}件含む）` : ''
      setReplayMsg({ id: c.id, text: `再解析完了${attachMsg}。既存候補を上書き更新しました。`, ok: true })
      queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
      queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
    } catch (e) {
      setReplayMsg({ id: c.id, text: `再解析失敗: ${String(e)}`, ok: false })
    } finally {
      setReplayingId(null)
    }
  }

  async function handleBoxFileUpload(c: Candidate, file: File) {
    setBoxUploadingId(c.id)
    setBoxUploadMsg(null)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      let binary = ''
      for (let i = 0; i < bytes.byteLength; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      }
      const b64 = btoa(binary)

      const originalFrom = (c.raw_profile as RawProfile)?.from ?? `box+${c.id}@upload.invalid`
      const { error } = await supabase.functions.invoke('inbound-email', {
        body: {
          subject: `【Box経歴書】${c.name ?? ''}`,
          body: `Box経歴書ファイル取込: ${file.name}`,
          from: originalFrom,
          attachments: [{ data: b64, mimeType: file.type || 'application/octet-stream', name: file.name }],
          mode: dataEnv,
          type: 'candidate',
          force: true,
          target_candidate_id: c.id,
        },
      })
      if (error) throw error

      await supabase.from('candidates').update({ box_status: 'enriched' }).eq('id', c.id)

      setBoxUploadMsg({ id: c.id, text: `Box経歴書を取り込みました: ${file.name}`, ok: true })
      queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
      queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
    } catch (e) {
      setBoxUploadMsg({ id: c.id, text: `取り込み失敗: ${String(e)}`, ok: false })
    } finally {
      setBoxUploadingId(null)
      boxUploadTargetRef.current = null
    }
  }

  // Box経歴書ワンクリック取込: box_status='fetch_requested' にするだけで、
  // ThinkCentre常駐ワーカーが Boxダウンロード → inbound-email 再解析 → AI上書き まで裏で行う
  const requestBoxFetch = async (c: Candidate) => {
    setBoxUploadMsg(null)
    const { error } = await supabase
      .from('candidates')
      .update({ box_status: 'fetch_requested' })
      .eq('id', c.id)
    if (error) {
      setBoxUploadMsg({ id: c.id, text: `取込依頼に失敗しました: ${error.message}`, ok: false })
      return
    }
    queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
  }

  const { data: isImportActive } = useQuery({
    queryKey: ['importActive'],
    queryFn: getIsImportActive,
    refetchInterval: 30_000,
  })

  const { data: agentDomainMap } = useQuery({
    queryKey: ['agentDomainMap'],
    queryFn: fetchAgentDomainMap,
    staleTime: 5 * 60_000,
  })

  const isFiltered = !!(
    appliedFilter.name ||
    appliedFilter.skills?.length ||
    appliedFilter.skillYearFilters?.length ||
    appliedFilter.prefecture ||
    appliedFilter.expMin != null
  )

  // 通常ブラウズ（検索なし）
  const browseInfiniteQuery = useInfiniteQuery({
    queryKey: ['candidates-paged', dataEnv],
    queryFn: ({ pageParam }: { pageParam: number }) => fetchCandidatesPage(dataEnv, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.candidates.length < 100 ? undefined : lastPageParam + 100,
    refetchInterval: isImportActive ? 30_000 : false,
    staleTime: 60_000,   // 1分間はキャッシュを使いタブ切替で再フェッチしない
    gcTime: 5 * 60_000,  // 5分間キャッシュを保持
    enabled: !isFiltered,
  })

  // フィルター検索（ポップアップで絞り込み条件を指定した場合）
  const filterInfiniteQuery = useInfiniteQuery({
    queryKey: ['candidates-filter', dataEnv, appliedFilter],
    queryFn: ({ pageParam }: { pageParam: number }) =>
      filterCandidates(dataEnv, appliedFilter, pageParam, 100),
    initialPageParam: 0,
    getNextPageParam: (lastPage: Candidate[], _: Candidate[][], lastPageParam: number) =>
      lastPage.length < 100 ? undefined : lastPageParam + 100,
    enabled: isFiltered,
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    isFiltered ? filterInfiniteQuery : browseInfiniteQuery

  const candidates = useMemo(
    () => isFiltered
      ? (filterInfiniteQuery.data?.pages.flat() ?? [])
      : (browseInfiniteQuery.data?.pages.flatMap(p => p.candidates) ?? []),
    [isFiltered, filterInfiniteQuery.data, browseInfiniteQuery.data],
  )

  // 全件数: offset=0 の初回ページ取得と同時に返ってくる totalCount を優先利用（HTTPラウンドトリップ削減）
  const countFromPages = browseInfiniteQuery.data?.pages[0]?.totalCount ?? null
  const { data: fetchedCount = 0 } = useQuery({
    queryKey: ['candidates-count', dataEnv],
    queryFn: () => fetchCandidateCount(dataEnv),
    enabled: countFromPages === null && !isFiltered,
    staleTime: 60_000,
  })
  const totalCount = countFromPages ?? fetchedCount

  // フィルター件数（フィルター適用時のみ）
  const { data: filteredCount = 0 } = useQuery({
    queryKey: ['candidates-filter-count', dataEnv, appliedFilter],
    queryFn: () => filterCandidateCount(dataEnv, appliedFilter),
    enabled: isFiltered,
  })

  // スキル年数クライアントフィルター（RPC では skillYears を参照できないため後続で絞り込む）
  const filteredCandidates = useMemo(() => {
    const syFilters = appliedFilter.skillYearFilters
    if (!syFilters?.length) return candidates
    return candidates.filter(c => {
      const skillYears = (c.raw_profile as Record<string, unknown>)?.skillYears as Record<string, number> | null | undefined
      if (!skillYears) return false
      return syFilters.every(({ skill, minYears }) => {
        const months = findSkillMonths(skillYears, skill)
        return months != null && months >= minYears * 12
      })
    })
  }, [candidates, appliedFilter.skillYearFilters])

  const onRegisterSuccess = (candidate: Candidate) => {
    queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
    queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
    setText('')
    setUploadedFileNames([])
    setShowRegisterModal(false)
    const msg = candidate.duplicate_flag
      ? `登録完了（重複の疑いフラグあり）: ${candidate.name}`
      : `登録完了: ${candidate.name}`
    setMessage({ type: 'success', text: msg })
    setSelectedId(candidate.id)
  }

  const noAiMutation = useMutation({
    mutationFn: async (rawText: string) => {
      const { data, error } = await supabase.functions.invoke('inbound-email', {
        body: {
          subject: '手入力登録',
          body: rawText,
          from: `manual+${nickname}@manual.invalid`,
          attachments: [],
          type: 'candidate',
          mode: dataEnv,
        },
      })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.error ?? `解析に失敗しました（reason: ${data?.reason ?? '不明'}）`)
      if (data?.skipped) throw new Error(`人材を登録できませんでした（reason: ${data?.reason ?? '不明'}）\n本文が短すぎる場合は50文字以上入力してください。`)
      // 登録されたIDで候補者を取得
      const { data: candidate, error: fetchErr } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', data.id)
        .single()
      if (fetchErr) throw new Error(fetchErr.message)
      return candidate as Candidate
    },
    onSuccess: onRegisterSuccess,
    onError: (e) => { setMessage({ type: 'error', text: String(e) }) },
  })

  const selectedCandidateBase = candidates.find((c: Candidate) => c.id === selectedId) ?? null

  // 詳細表示用: 選択時に fetch_candidate_raw_profile RPC で full raw_profile を取得
  // （一覧クエリは raw_profile を除外しているため）
  const { data: fullRawProfile, isLoading: isLoadingFullProfile } = useQuery({
    queryKey: ['candidate-raw-profile', selectedId],
    queryFn: () => fetchCandidateRawProfile(selectedId!),
    enabled: !!selectedId,
    staleTime: 60_000,
  })
  const selectedCandidate = useMemo(() => {
    if (!selectedCandidateBase) return null
    if (!fullRawProfile) return selectedCandidateBase
    return { ...selectedCandidateBase, raw_profile: { ...(selectedCandidateBase.raw_profile as Record<string, unknown> ?? {}), ...fullRawProfile } }
  }, [selectedCandidateBase, fullRawProfile])

  // 重複疑い候補者クエリ（duplicate_flag=true の場合のみ同名・直近90日・別IDを取得）
  const { data: dupCandidates } = useQuery({
    queryKey: ['dup-candidates', selectedCandidate?.id, selectedCandidate?.name, dataEnv],
    enabled: !!(selectedCandidate?.duplicate_flag && selectedCandidate?.name),
    queryFn: async () => {
      const { supabase } = await import('../lib/supabase')
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      const { data } = await supabase
        .from('candidates')
        .select('id, name, skills, experience_years, desired_rate, from_company, raw_profile, created_at')
        .eq('data_env', dataEnv)
        .eq('name', selectedCandidate!.name)
        .neq('id', selectedCandidate!.id)
        .gte('created_at', since)
        .limit(5)
      return (data ?? []) as Candidate[]
    },
  })

  // Box取込中はワーカーの進捗をポーリングして画面に反映する
  // （処理本体はサーバー側の常駐ワーカーなので、タブ移動・リロードしても継続する）
  const boxWorking = selectedCandidate?.box_status === 'fetch_requested' || selectedCandidate?.box_status === 'fetching'
  useQuery({
    queryKey: ['box-fetch-poll', selectedCandidate?.id],
    enabled: boxWorking,
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('candidates')
        .select('id, box_status, resume_url')
        .eq('id', selectedCandidate!.id)
        .single()
      if (data && (data.box_status !== selectedCandidate!.box_status || data.resume_url !== selectedCandidate!.resume_url)) {
        queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
      }
      return data
    },
  })

  return (
    <div className="space-y-6">
      {/* 編集モーダル */}
      {editingCandidate && (
        <CandidateEditModal
          candidate={editingCandidate}
          nickname={nickname}
          dataEnv={dataEnv}
          onClose={() => setEditingCandidate(null)}
          onSaved={() => {
            setEditingCandidate(null)
            queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
          }}
        />
      )}

      {demoUiEnabled && dataEnv === 'demo' && (
        <DemoSeedPanel
          nickname={nickname}
          createdByLabel="デモ人材"
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['projects', 'all', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['projects', 'open', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['submission-stats', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-projects', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-candidates', dataEnv] })
          }}
        />
      )}

      {demoUiEnabled && dataEnv === 'demo' && (
        <DemoMatchingTestPanel
          nickname={nickname}
          dataEnv={dataEnv}
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['projects', 'all', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['projects', 'open', dataEnv] })
          }}
        />
      )}

      {/* 絞り込みポップアップ */}
      {showFilterPopup && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
                <SlidersHorizontal size={18} className="text-blue-600" />
                人材を絞り込む
              </h2>
              <button onClick={() => setShowFilterPopup(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* 氏名 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">氏名</label>
                <input
                  type="text"
                  value={filterDraft.name}
                  onChange={e => setFilterDraft(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="例: 田中"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>

              {/* スキル */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">スキル（Enter または , で追加）</label>
                <p className="text-xs text-gray-400 mb-1.5">「Java 10年」のように入力すると年数でも絞り込めます</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {filterDraft.skills.map(s => (
                    <span key={s} className="flex items-center gap-1 bg-green-50 text-green-700 text-xs rounded-full px-2.5 py-1">
                      {s}
                      <button
                        type="button"
                        onClick={() => setFilterDraft(prev => ({ ...prev, skills: prev.skills.filter(x => x !== s) }))}
                        className="hover:text-red-500"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  {filterDraft.skillYearFilters.map(f => (
                    <span key={`${f.skill}-${f.minYears}`} className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs rounded-full px-2.5 py-1">
                      {f.skill}（{f.minYears}年↑）
                      <button
                        type="button"
                        onClick={() => setFilterDraft(prev => ({ ...prev, skillYearFilters: prev.skillYearFilters.filter(x => x.skill !== f.skill) }))}
                        className="hover:text-red-500"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  type="text"
                  value={filterDraft.skillInput}
                  onChange={e => {
                    const val = e.target.value
                    if (val.endsWith(',')) {
                      const raw = val.slice(0, -1).trim()
                      const syf = parseSkillYear(raw)
                      if (syf) {
                        if (!filterDraft.skillYearFilters.some(x => x.skill === syf.skill)) {
                          setFilterDraft(prev => ({ ...prev, skillYearFilters: [...prev.skillYearFilters, syf], skillInput: '' }))
                        } else {
                          setFilterDraft(prev => ({ ...prev, skillInput: '' }))
                        }
                      } else if (raw && !filterDraft.skills.includes(raw)) {
                        setFilterDraft(prev => ({ ...prev, skills: [...prev.skills, raw], skillInput: '' }))
                      } else {
                        setFilterDraft(prev => ({ ...prev, skillInput: '' }))
                      }
                    } else {
                      setFilterDraft(prev => ({ ...prev, skillInput: val }))
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const raw = filterDraft.skillInput.trim()
                      const syf = parseSkillYear(raw)
                      if (syf) {
                        if (!filterDraft.skillYearFilters.some(x => x.skill === syf.skill)) {
                          setFilterDraft(prev => ({ ...prev, skillYearFilters: [...prev.skillYearFilters, syf], skillInput: '' }))
                        }
                      } else if (raw && !filterDraft.skills.includes(raw)) {
                        setFilterDraft(prev => ({ ...prev, skills: [...prev.skills, raw], skillInput: '' }))
                      }
                    }
                  }}
                  placeholder="例: Java　または　Java 10年"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* 都道府県 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">都道府県</label>
                <select
                  value={filterDraft.prefecture}
                  onChange={e => setFilterDraft(prev => ({ ...prev, prefecture: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">すべて</option>
                  {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>

              {/* 経験年数 */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">経験年数（以上）</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={40}
                    value={filterDraft.expMin}
                    onChange={e => setFilterDraft(prev => ({ ...prev, expMin: e.target.value }))}
                    placeholder="0"
                    className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-600">年以上</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => { setFilterDraft(EMPTY_DRAFT); setAppliedFilter({}); setShowFilterPopup(false) }}
                className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                クリア
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowFilterPopup(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // 入力中のスキルを確定（年数付きかどうか判定）
                    const raw = filterDraft.skillInput.trim()
                    const skills = [...filterDraft.skills]
                    const skillYearFilters = [...filterDraft.skillYearFilters]
                    if (raw) {
                      const syf = parseSkillYear(raw)
                      if (syf && !skillYearFilters.some(x => x.skill === syf.skill)) {
                        skillYearFilters.push(syf)
                      } else if (!syf && !skills.includes(raw)) {
                        skills.push(raw)
                      }
                    }
                    const filter: CandidateFilter = {}
                    if (filterDraft.name.trim()) filter.name = filterDraft.name.trim()
                    if (skills.length > 0) filter.skills = skills
                    if (skillYearFilters.length > 0) filter.skillYearFilters = skillYearFilters
                    if (filterDraft.prefecture) filter.prefecture = filterDraft.prefecture
                    if (filterDraft.expMin.trim() !== '') filter.expMin = parseInt(filterDraft.expMin, 10)
                    setFilterDraft(prev => ({ ...prev, skills, skillYearFilters, skillInput: '' }))
                    setAppliedFilter(filter)
                    setShowFilterPopup(false)
                  }}
                  className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  <SlidersHorizontal size={14} />
                  検索する
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 登録モーダル */}
      {showRegisterModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
                <UserPlus size={18} className="text-blue-600" />
                人材を登録
              </h2>
              <button
                onClick={() => { setShowRegisterModal(false); setMessage(null) }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-500">
                メール本文・職務経歴書・スキルシートなどのテキストを貼り付けてください。
                AI が自動解析して登録します。同じメールアドレスの場合は上書き更新されます。
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="テキストをここに貼り付け..."
                rows={10}
                className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                autoFocus
              />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,.xlsx,.xls,.docx"
                  multiple
                  className="hidden"
                  onChange={handleFileChange}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={fileLoading || noAiMutation.isPending}
                  className="flex items-center gap-1.5 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {fileLoading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                  {fileLoading ? '読み込み中...' : 'PDF・Excel・Word・画像を添付'}
                </button>
                {uploadedFileNames.map((name, i) => (
                  <span key={i} className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs rounded px-2 py-1">
                    {name}
                    <button onClick={() => removeFile(i)} className="hover:text-red-500 ml-0.5">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              {message && (
                <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                  {message.text}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-200 flex-wrap">
              <button
                onClick={() => { setShowRegisterModal(false); setMessage(null) }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={() => { setMessage(null); noAiMutation.mutate(text) }}
                disabled={!text.trim() || noAiMutation.isPending || fileLoading}
                className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {noAiMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
                {noAiMutation.isPending ? '解析中...' : '登録'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 候補者一覧 - Split layout */}
      <div className="bg-white rounded-xl border border-gray-200 min-w-0">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-wrap">
          <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <RefreshCw size={18} className="text-gray-500" />
            登録済み人材（{isFiltered ? `絞り込み${filteredCount}件 / ` : ''}全{totalCount}件）
          </h2>
          <button
            type="button"
            onClick={() => { setMessage(null); setShowRegisterModal(true) }}
            className="flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-700 transition-colors shrink-0"
          >
            <UserPlus size={15} />
            新規登録
          </button>
          <button
            type="button"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['candidates-paged', dataEnv] })
              queryClient.invalidateQueries({ queryKey: ['candidates-count', dataEnv] })
            }}
            className="flex items-center gap-1.5 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors shrink-0"
            title="データを再読み込み"
          >
            <RefreshCw size={14} />
          </button>
          {onOpenHeatmap && (
            <button
              type="button"
              onClick={onOpenHeatmap}
              className="flex items-center gap-1.5 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors shrink-0"
              title="都道府県別の人材分布マップを表示"
            >
              <MapIcon size={14} />
              人材マップ
            </button>
          )}
          <AgentCompaniesModal />
          {/* 絞り込みボタン */}
          <button
            type="button"
            onClick={() => setShowFilterPopup(true)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors shrink-0 ${
              isFiltered
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <SlidersHorizontal size={14} />
            絞り込み
          </button>

          {/* アクティブフィルターバッジ */}
          {isFiltered && (
            <div className="flex flex-wrap gap-1 items-center">
              {appliedFilter.name && (
                <span className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs rounded-full px-2.5 py-1">
                  氏名: {appliedFilter.name}
                  <button onClick={() => setAppliedFilter(prev => ({ ...prev, name: undefined }))} className="hover:text-red-500"><X size={10} /></button>
                </span>
              )}
              {appliedFilter.skills?.map(s => (
                <span key={s} className="flex items-center gap-1 bg-green-50 text-green-700 text-xs rounded-full px-2.5 py-1">
                  {s}
                  <button onClick={() => setAppliedFilter(prev => ({ ...prev, skills: prev.skills?.filter(x => x !== s) }))} className="hover:text-red-500"><X size={10} /></button>
                </span>
              ))}
              {appliedFilter.skillYearFilters?.map(f => (
                <span key={`${f.skill}-${f.minYears}`} className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs rounded-full px-2.5 py-1">
                  {f.skill}（{f.minYears}年↑）
                  <button onClick={() => setAppliedFilter(prev => ({ ...prev, skillYearFilters: prev.skillYearFilters?.filter(x => x.skill !== f.skill) }))} className="hover:text-red-500"><X size={10} /></button>
                </span>
              ))}
              {appliedFilter.prefecture && (
                <span className="flex items-center gap-1 bg-purple-50 text-purple-700 text-xs rounded-full px-2.5 py-1">
                  {appliedFilter.prefecture}
                  <button onClick={() => setAppliedFilter(prev => ({ ...prev, prefecture: undefined }))} className="hover:text-red-500"><X size={10} /></button>
                </span>
              )}
              {appliedFilter.expMin != null && (
                <span className="flex items-center gap-1 bg-orange-50 text-orange-700 text-xs rounded-full px-2.5 py-1">
                  経験{appliedFilter.expMin}年+
                  <button onClick={() => setAppliedFilter(prev => ({ ...prev, expMin: undefined }))} className="hover:text-red-500"><X size={10} /></button>
                </span>
              )}
              <button
                type="button"
                onClick={() => { setAppliedFilter({}); setFilterDraft(EMPTY_DRAFT) }}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                クリア
              </button>
            </div>
          )}
        </div>

        {message && (
          <div className={`mx-4 mt-3 text-sm rounded-lg px-3 py-2 ${message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {message.text}
          </div>
        )}

        {isLoading || (isFiltered && filterInfiniteQuery.isLoading) ? (
          <p className="text-sm text-gray-400 p-4">読み込み中...</p>
        ) : isError ? (
          <p className="text-sm text-red-500 p-4">読み込みエラー: {(error as Error)?.message ?? '不明なエラー'}</p>
        ) : candidates.length === 0 && !isFiltered ? (
          <p className="text-sm text-gray-400 p-4">まだ登録されていません</p>
        ) : candidates.length === 0 && isFiltered ? (
          <p className="text-sm text-gray-400 p-4">絞り込み条件に一致する人材が見つかりません</p>
        ) : (
          <div className="flex flex-col md:flex-row">
            {/* Left: candidate list（モバイルで詳細表示中は非表示） */}
            <div ref={listScrollRef} className={`w-full md:w-64 lg:w-72 shrink-0 border-b md:border-b-0 md:border-r border-gray-100 overflow-y-auto md:max-h-[640px] ${selectedId ? 'hidden md:block' : ''}`}>
              {filteredCandidates.map((c: Candidate) => {
                const raw = getRaw(c)
                const sbc = raw.skillsByCategory
                const skillCount = sbc
                  ? Object.values(sbc).reduce((s, a) => s + (a?.length ?? 0), 0)
                  : (c.skills as string[]).length
                const isSelected = selectedId === c.id
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!isSelected) savedScrollTop.current = listScrollRef.current?.scrollTop ?? 0
                      setSelectedId(isSelected ? null : c.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (!isSelected) savedScrollTop.current = listScrollRef.current?.scrollTop ?? 0
                        setSelectedId(isSelected ? null : c.id)
                      }
                    }}
                    className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-50 last:border-0 transition-colors ${
                      isSelected
                        ? 'bg-blue-50 border-l-2 border-l-blue-500'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate flex items-center gap-1">
                        {c.name}
                        {c.duplicate_flag && (
                          <span className="text-[10px] bg-yellow-100 text-yellow-700 rounded px-1 shrink-0">重複</span>
                        )}
                        {isAiCorrectionPending(c) && (
                          <span
                            className="text-[10px] bg-sky-50 text-sky-600 border border-sky-200 rounded px-1 shrink-0"
                            title="登録直後です。常駐AIが本文・経歴書を読み直して補正します（平均20分以内）"
                          >
                            AI校正中
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5 flex-wrap">
                        <span>経験{c.experience_years ?? '?'}年</span>
                        <span>·</span>
                        <span>{skillCount}スキル</span>
                        {(c as unknown as { from_company?: string }).from_company && (
                          <>
                            <span>·</span>
                            <span className="truncate max-w-[80px]">{(c as unknown as { from_company?: string }).from_company}</span>
                          </>
                        )}
                        {(c as unknown as { desired_rate?: string }).desired_rate && (
                          <>
                            <span>·</span>
                            <span className="text-green-600 font-medium">{(c as unknown as { desired_rate?: string }).desired_rate}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {isSelected && <ChevronRight size={14} className="text-blue-400 shrink-0" />}
                  </div>
                )
              })}
              {hasNextPage && (
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="w-full py-2.5 text-xs text-blue-600 hover:bg-blue-50 border-t border-gray-100 transition-colors disabled:opacity-50"
                >
                  {isFetchingNextPage ? '読み込み中...' : `もっと見る（${isFiltered ? filteredCount : totalCount}件中${candidates.length}件表示）`}
                </button>
              )}
            </div>

            {/* Right: detail panel（モバイルで未選択時は非表示） */}
            <div className={`flex-1 overflow-y-auto md:max-h-[640px] ${!selectedId ? 'hidden md:block' : ''}`}>
              {selectedCandidate ? (
                <div className="p-4 space-y-4">
                  {/* モバイル用「一覧に戻る」ボタン */}
                  <button
                    type="button"
                    onClick={() => { setSelectedId(null) }}
                    className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 md:hidden -mt-1 mb-1"
                  >
                    ← 一覧に戻る
                  </button>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-gray-800">{selectedCandidate.name}</h3>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {(selectedCandidate as unknown as { from_company?: string }).from_company && (
                          <span className="text-xs text-gray-500 bg-gray-100 rounded px-2 py-0.5">
                            🏢 {(selectedCandidate as unknown as { from_company?: string }).from_company}
                          </span>
                        )}
                        {(() => {
                          const cf = (getRaw(selectedCandidate) as Record<string, unknown>).commercialFlow as string | null | undefined
                          if (!cf) return null
                          const num = Number(cf.match(/^(\d+)社先/)?.[1] ?? 0)
                          const cls = cf === '自社'
                            ? 'bg-emerald-100 text-emerald-800 font-medium'
                            : num >= 2 ? 'bg-red-100 text-red-700 font-medium' : 'bg-amber-100 text-amber-800 font-medium'
                          return <span className={`text-xs rounded px-2 py-0.5 ${cls}`} title="商流位置（自社=直接紹介可 / N社先=N社を挟む）">{cf}</span>
                        })()}
                        {(() => {
                          const et = (getRaw(selectedCandidate) as Record<string, unknown>).employmentType as string | null | undefined
                          if (!et) return null
                          const styles: Record<string, string> = {
                            '正社員': 'bg-slate-100 text-slate-700',
                            '契約社員': 'bg-purple-50 text-purple-700',
                            '派遣社員': 'bg-orange-50 text-orange-700',
                            'フリーランス': 'bg-sky-50 text-sky-700',
                            '業務委託': 'bg-teal-50 text-teal-700',
                          }
                          const cls = styles[et] ?? 'bg-gray-50 text-gray-600'
                          return <span className={`text-xs rounded px-2 py-0.5 ${cls}`}>{et}</span>
                        })()}
                        {(() => {
                          const rawP = getRaw(selectedCandidate) as Record<string, unknown>
                          const tag = rawP.workStyleTag as string | null | undefined
                          const note = rawP.workStyleNote as string | null | undefined
                          if (!tag && !note) return null
                          const label = tag ?? '勤務条件'
                          const cls = label === '常駐可' ? 'bg-emerald-100 text-emerald-800'
                            : label === 'リモート希望' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'
                          return (
                            <span className={`text-xs rounded px-2 py-0.5 font-medium ${cls}`} title={note ? `本文: ${note}` : undefined}>
                              {label}{note && <span className="font-normal opacity-70">（{note}）</span>}
                            </span>
                          )
                        })()}
                        {(selectedCandidate as unknown as { desired_rate?: string }).desired_rate && (
                          <span className="text-xs text-green-700 bg-green-50 rounded px-2 py-0.5 font-medium">
                            {(selectedCandidate as unknown as { desired_rate?: string }).desired_rate}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {(() => {
                        // drive_url → resume_url → raw_profile.text内のDrive URL の順で探す
                        const resumeLink = selectedCandidate.drive_url || selectedCandidate.resume_url || (() => {
                          const bodyText = (selectedCandidate.raw_profile as { text?: string })?.text ?? ''
                          const m = bodyText.match(/https:\/\/drive\.google\.com\/[^\s"'<>\]）]+/)
                          return m ? m[0] : null
                        })()
                        return resumeLink ? (
                          <a
                            href={toViewerUrl(resumeLink)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-blue-200 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
                            title="経歴書を開く"
                          >
                            <ExternalLink size={14} />
                            経歴書
                          </a>
                        ) : null
                      })()}
                      {selectedCandidate.box_url && (
                        <>
                          <a
                            href={selectedCandidate.box_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-orange-200 rounded-lg text-orange-600 hover:bg-orange-50 transition-colors"
                            title="Box経歴書を開く"
                          >
                            <ExternalLink size={14} />
                            Box{selectedCandidate.box_status === 'pending' ? '（処理待ち）' : ''}
                          </a>
                          {boxWorking ? (
                            <span
                              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-orange-300 rounded-lg text-orange-700 bg-orange-50"
                              title="サーバー側で処理中です。他の画面に移動しても継続します"
                            >
                              <Loader2 size={14} className="animate-spin" />
                              {selectedCandidate.box_status === 'fetching' ? 'Box取込・AI解析中…' : '取込待機中…'}
                            </span>
                          ) : (selectedCandidate.box_status === 'pending' || selectedCandidate.box_status === 'failed') && (
                            <>
                              <button
                                type="button"
                                onClick={() => requestBoxFetch(selectedCandidate)}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-orange-400 rounded-lg text-white bg-orange-500 hover:bg-orange-600 transition-colors"
                                title="Boxから経歴書を自動ダウンロードして再解析（AI上書きまで自動）"
                              >
                                <RefreshCw size={14} />
                                {selectedCandidate.box_status === 'failed' ? 'AI取込 再試行' : 'AI取込'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  boxUploadTargetRef.current = selectedCandidate
                                  boxFileInputRef.current?.click()
                                }}
                                disabled={boxUploadingId === selectedCandidate.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-orange-300 rounded-lg text-orange-700 hover:bg-orange-50 transition-colors disabled:opacity-50"
                                title="Boxからダウンロードしたファイルをアップロードして解析"
                              >
                                {boxUploadingId === selectedCandidate.id
                                  ? <Loader2 size={14} className="animate-spin" />
                                  : <Paperclip size={14} />}
                                ファイルで更新
                              </button>
                            </>
                          )}
                        </>
                      )}
                      {getRaw(selectedCandidate).from && (() => {
                        const raw = getRaw(selectedCandidate)
                        const subject = encodeURIComponent(`Re: ${raw.subject ?? ''}`)
                        const originalText = raw.text ?? ''
                        const truncated = originalText.slice(0, 800)
                        const quoted = [
                          '',
                          '',
                          '--- 元のメッセージ ---',
                          `差出人: ${raw.from ?? ''}`,
                          `件名: ${raw.subject ?? ''}`,
                          raw.emailReceivedAt ? `日時: ${new Date(raw.emailReceivedAt).toLocaleString('ja-JP')}` : '',
                          '',
                          truncated,
                          originalText.length > 800 ? `\n...[以下省略]` : '',
                        ].filter(s => s !== undefined).join('\n')
                        const body = encodeURIComponent(quoted)
                        return (
                          <a
                            href={`mailto:${raw.from}?subject=${subject}&body=${body}`}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                            title="返信（元メール引用）"
                          >
                            <Reply size={14} />
                            返信
                          </a>
                        )
                      })()}
                      {getRaw(selectedCandidate).text && (
                        <button
                          type="button"
                          onClick={() => handleReplay(selectedCandidate)}
                          disabled={replayingId === selectedCandidate.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-violet-200 rounded-lg text-violet-600 hover:text-violet-800 hover:border-violet-400 transition-colors disabled:opacity-50"
                          title="保存済みメール本文を再解析して新規登録"
                        >
                          {replayingId === selectedCandidate.id
                            ? <Loader2 size={14} className="animate-spin" />
                            : <RefreshCw size={14} />}
                          再解析
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingCandidate(selectedCandidate)}
                        disabled={isLoadingFullProfile}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors disabled:opacity-40"
                        title={isLoadingFullProfile ? '読み込み中...' : '編集'}
                      >
                        <Pencil size={14} />
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(selectedCandidate)}
                        disabled={deletingId === selectedCandidate.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-red-600 hover:border-red-300 transition-colors disabled:opacity-50"
                        title="削除"
                      >
                        {deletingId === selectedCandidate.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Trash2 size={14} />}
                        削除
                      </button>
                    </div>
                  </div>
                  {replayMsg?.id === selectedCandidate.id && (
                    <p className={`text-xs px-3 py-2 rounded-lg ${replayMsg.ok ? 'bg-violet-50 text-violet-700' : 'bg-red-50 text-red-700'}`}>
                      {replayMsg.text}
                    </p>
                  )}
                  {boxUploadMsg?.id === selectedCandidate.id && (
                    <p className={`text-xs px-3 py-2 rounded-lg ${boxUploadMsg.ok ? 'bg-orange-50 text-orange-700' : 'bg-red-50 text-red-700'}`}>
                      {boxUploadMsg.text}
                    </p>
                  )}
                  <CandidateProfileFields c={selectedCandidate} isExpanded detailMode agentDomainMap={agentDomainMap} />
                  {/* 重複候補者 */}
                  {selectedCandidate.duplicate_flag && dupCandidates && dupCandidates.length > 0 && (
                    <details className="mt-4 border border-yellow-200 rounded-lg bg-yellow-50">
                      <summary className="px-3 py-2 text-xs font-medium text-yellow-700 cursor-pointer select-none hover:bg-yellow-100 rounded-lg flex items-center gap-1">
                        <span className="text-yellow-500">⚠</span>
                        重複の疑い {dupCandidates.length}件
                      </summary>
                      <div className="px-3 pb-3 pt-1 space-y-2">
                        {dupCandidates.map((dup) => (
                          <div key={dup.id} className="bg-white border border-yellow-200 rounded-lg p-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-semibold text-gray-800">{dup.name}</p>
                                {/* 会社・登録日・経験年数 */}
                                <p className="text-[10px] text-gray-400 mt-0.5">
                                  {(dup as any).from_company && (
                                    <span className="text-blue-500 font-medium">{(dup as any).from_company}　</span>
                                  )}
                                  {(() => {
                                    const emailAt = (dup as any).raw_profile?.emailReceivedAt
                                    const dt = emailAt ? new Date(emailAt) : new Date(dup.created_at ?? '')
                                    return dt.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                  })()}
                                  {(dup as any).experience_years != null && `　経験${(dup as any).experience_years}年`}
                                </p>
                                {/* 単価・最寄駅・稼働時期 */}
                                <p className="text-[10px] text-gray-600 mt-0.5 flex flex-wrap gap-x-2">
                                  {(dup as any).desired_rate && (
                                    <span className="text-green-700 font-medium">{(dup as any).desired_rate}</span>
                                  )}
                                  {((dup as any).raw_profile?.nearestStation || (dup as any).raw_profile?.prefecture) && (
                                    <span>
                                      📍{(dup as any).raw_profile?.nearestStation ?? (dup as any).raw_profile?.prefecture}
                                    </span>
                                  )}
                                  {((dup as any).raw_profile?.availableFrom ?? (dup as any).raw_profile?.aiAnalysis?.availableFrom) && (
                                    <span>🕐{(dup as any).raw_profile.availableFrom ?? (dup as any).raw_profile.aiAnalysis?.availableFrom}</span>
                                  )}
                                </p>
                                {/* スキル */}
                                {Array.isArray(dup.skills) && dup.skills.length > 0 && (
                                  <p className="text-[10px] text-gray-500 mt-1 truncate">
                                    {(dup.skills as string[]).slice(0, 8).join(' / ')}
                                  </p>
                                )}
                              </div>
                              <button
                                onClick={() => setSelectedId(dup.id)}
                                className="shrink-0 text-[10px] bg-yellow-100 hover:bg-yellow-200 text-yellow-700 rounded px-2 py-1 whitespace-nowrap"
                              >
                                この人を見る
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {/* 元メール本文 */}
                  {(() => {
                    const raw = getRaw(selectedCandidate)
                    const bodyText = raw.text ?? ''
                    if (!bodyText.trim()) return null
                    return (
                      <details className="mt-4 border border-gray-200 rounded-lg">
                        <summary className="px-3 py-2 text-xs font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-50 rounded-lg">
                          元メール本文
                        </summary>
                        <div className="px-3 pb-3 pt-1">
                          {raw.subject && (
                            <p className="text-xs text-gray-400 mb-1">件名: {raw.subject}</p>
                          )}
                          {raw.from && (
                            <p className="text-xs text-gray-400 mb-2">差出人: {raw.from}</p>
                          )}
                          <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed bg-gray-50 rounded p-2 max-h-96 overflow-y-auto">
                            {bodyText}
                          </pre>
                        </div>
                      </details>
                    )
                  })()}
                </div>
              ) : (
                <div className="flex items-center justify-center h-32 md:h-full text-sm text-gray-400 p-8 text-center">
                  ← 左のリストから人材を選択すると詳細が表示されます
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {/* Box ファイルアップロード用 hidden input */}
      <input
        ref={boxFileInputRef}
        type="file"
        accept=".xlsx,.xls,.docx,.doc"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          const target = boxUploadTargetRef.current
          if (file && target) await handleBoxFileUpload(target, file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
