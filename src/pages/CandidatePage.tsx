import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, UserPlus, RefreshCw, Trash2, ChevronDown, ChevronUp, MapPin, Wifi, Search, Mail, Pencil, X } from 'lucide-react'
import { ai } from '../lib/ai'
import { upsertCandidate, updateCandidate, fetchCandidates, deleteCandidate } from '../lib/db/candidates'
import type { Candidate } from '../lib/db/candidates'

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
}

function getRaw(c: Candidate): RawProfile {
  return (c.raw_profile ?? {}) as RawProfile
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
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
}: {
  c: Candidate
  isExpanded: boolean
  onToggleExpand?: () => void
  /** true のとき常に全表示（詳細画面） */
  detailMode?: boolean
}) {
  const raw = getRaw(c)
  const { skillsByCategory: sbc, roles, industries,
    prefecture, nearestStation, availableRegions,
    currentWorkLocation, remoteAvailable,
    from: mailFrom, subject: mailSubject } = raw

  const totalSkills = sbc
    ? Object.values(sbc).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
    : (c.skills as string[]).length
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
      </div>
      <p className="text-xs text-gray-400 mt-0.5">
        {c.email ?? 'メールなし'} ／ 経験{c.experience_years ?? '?'}年
      </p>

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
          {remoteAvailable && (
            <span className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">
              <Wifi size={10} />リモート可
            </span>
          )}
        </div>
      )}

      <div className="mt-1.5 border-t border-gray-50 pt-1.5 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
            <Mail size={10} />
            受信: {c.created_at ? formatDate(c.created_at) : '—'}
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
            {(roles ?? []).map((r) => (
              <span key={r} className="text-xs bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5">{r}</span>
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

        {sbc ? (
          (Object.keys(CATEGORY_STYLE) as (keyof SkillsByCategory)[]).map((key) => {
            const items = sbc[key]
            if (!items || items.length === 0) return null
            const { label, badge } = CATEGORY_STYLE[key]
            const shown = showAll ? items : items.slice(0, COLLAPSED_PER_CATEGORY)
            const hidden = items.length - COLLAPSED_PER_CATEGORY
            return (
              <div key={key} className="flex flex-wrap gap-1 items-center">
                <span className="text-xs text-gray-400 w-12 shrink-0">{label}</span>
                {shown.map((s) => (
                  <span key={s} className={`text-xs rounded px-1.5 py-0.5 ${badge}`}>{s}</span>
                ))}
                {!showAll && hidden > 0 && (
                  <span className="text-xs text-gray-400">+{hidden}</span>
                )}
              </div>
            )
          })
        ) : (
          <div className="flex flex-wrap gap-1">
            {(showAll
              ? (c.skills as string[])
              : (c.skills as string[]).slice(0, COLLAPSED_PER_CATEGORY)
            ).map((s) => (
              <span key={s} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{s}</span>
            ))}
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
  onClose: () => void
  onSaved: () => void
}

export function CandidateEditModal({ candidate, nickname, onClose, onSaved }: EditModalProps) {
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
        supabase.from('candidates').update({ skills: allSkills }).eq('id', candidate.id)
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
  /** カードクリックで人材詳細へ（未指定時は遷移なし） */
  onOpenCandidateDetail?: (candidateId: string) => void
}

export function CandidatePage({ nickname, onOpenCandidateDetail }: Props) {
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [editingCandidate, setEditingCandidate] = useState<Candidate | null>(null)
  const queryClient = useQueryClient()

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const deleteMutation = useMutation({
    mutationFn: deleteCandidate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
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

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ['candidates'],
    queryFn: fetchCandidates,
  })

  const filteredCandidates = candidates.filter((c: Candidate) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    const raw = getRaw(c)
    const sbc = raw.skillsByCategory
    const allSkills = sbc
      ? Object.values(sbc).flat()
      : (c.skills as string[])
    const searchTargets = [
      c.name,
      c.email,
      c.phone,
      ...(raw.roles ?? []),
      ...(raw.industries ?? []),
      ...allSkills,
      raw.prefecture,
      raw.nearestStation,
      raw.currentWorkLocation,
      ...(raw.availableRegions ?? []),
    ].filter(Boolean).map((s) => s!.toLowerCase())
    return searchTargets.some((t) => t.includes(q))
  })

  const mutation = useMutation({
    mutationFn: async (rawText: string) => {
      const analyzed = await ai.analyzeCandidate({ rawText })
      return upsertCandidate({ analyzed, rawText, createdBy: nickname })
    },
    onSuccess: (candidate) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setText('')
      const msg = candidate.duplicate_flag
        ? `登録完了（重複の疑いフラグあり）: ${candidate.name}`
        : `登録完了: ${candidate.name}`
      setMessage({ type: 'success', text: msg })
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
    },
  })

  return (
    <div className="space-y-6">
      {/* 編集モーダル */}
      {editingCandidate && (
        <CandidateEditModal
          candidate={editingCandidate}
          nickname={nickname}
          onClose={() => setEditingCandidate(null)}
          onSaved={() => {
            setEditingCandidate(null)
            queryClient.invalidateQueries({ queryKey: ['candidates'] })
          }}
        />
      )}

      {/* 入力フォーム */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
          <UserPlus size={18} className="text-blue-600" />
          人材を登録
        </h2>
        <p className="text-sm text-gray-500">
          メール本文・職務経歴書・スキルシートなどのテキストを貼り付けてください。
          AI が自動解析して登録します。同じメールアドレスの場合は上書き更新されます。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="テキストをここに貼り付け..."
          rows={8}
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </p>
        )}
        <button
          onClick={() => { setMessage(null); mutation.mutate(text) }}
          disabled={!text.trim() || mutation.isPending}
          className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
          {mutation.isPending ? 'AI解析中...' : '解析して登録'}
        </button>
      </div>

      {/* 候補者一覧 */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <RefreshCw size={18} className="text-gray-500" />
            登録済み人材（{searchQuery.trim() ? `${filteredCandidates.length} / ${candidates.length}` : candidates.length}件）
          </h2>
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="名前・スキル・業界・勤務地などで検索..."
              className="w-full border border-gray-300 rounded-lg pl-8 pr-4 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        {isLoading ? (
          <p className="text-sm text-gray-400">読み込み中...</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-gray-400">まだ登録されていません</p>
        ) : filteredCandidates.length === 0 ? (
          <p className="text-sm text-gray-400">「{searchQuery}」に一致する人材が見つかりません</p>
        ) : (
          <div className="space-y-3">
            {filteredCandidates.map((c: Candidate) => {
              const isExpanded = expandedIds.has(c.id)
              const openDetail = onOpenCandidateDetail
              return (
                <div
                  key={c.id}
                  role={openDetail ? 'button' : undefined}
                  tabIndex={openDetail ? 0 : undefined}
                  onClick={openDetail ? () => openDetail(c.id) : undefined}
                  onKeyDown={
                    openDetail
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openDetail(c.id)
                          }
                        }
                      : undefined
                  }
                  className={`border border-gray-100 rounded-lg p-4 ${openDetail ? 'cursor-pointer hover:border-blue-200 hover:bg-blue-50/30 transition-colors' : ''}`}
                >
                  <div className="flex items-start justify-between">
                    <CandidateProfileFields
                      c={c}
                      isExpanded={isExpanded}
                      onToggleExpand={() => toggleExpand(c.id)}
                    />

                    <div className="flex items-center gap-2 ml-4 shrink-0">
                      <span className="text-xs text-gray-300">{c.created_by}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingCandidate(c)
                        }}
                        className="text-gray-300 hover:text-blue-500 transition-colors"
                        title="編集"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(c)
                        }}
                        disabled={deletingId === c.id}
                        className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-50"
                        title="削除"
                      >
                        {deletingId === c.id
                          ? <Loader2 size={15} className="animate-spin" />
                          : <Trash2 size={15} />}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
