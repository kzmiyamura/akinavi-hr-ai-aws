import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, UserPlus, RefreshCw, Trash2, ChevronDown, ChevronUp, MapPin, Wifi, Search, Mail, Pencil, X, Paperclip, ChevronRight, ExternalLink, Reply } from 'lucide-react'
import { ai } from '../lib/ai'
import { upsertCandidate, updateCandidate, fetchCandidates, deleteCandidate } from '../lib/db/candidates'
import { getIsImportActive } from '../lib/db/emailSettings'
import type { Candidate } from '../lib/db/candidates'
import type { DataEnv } from '../lib/dataEnv'
import type { ImageFileData } from '../lib/ai/types'
import { DemoSeedPanel } from '../components/DemoSeedPanel'
import { extractTextFromPDF, extractTextFromExcel, extractTextFromWord, imageFileToBase64, getFileCategory } from '../lib/fileParser'

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
}

export function CandidatePage({ nickname, dataEnv, demoUiEnabled = false, onOpenCandidateDetail: _onOpenCandidateDetail }: Props) {
  const [showRegisterModal, setShowRegisterModal] = useState(false)
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingCandidate, setEditingCandidate] = useState<Candidate | null>(null)
  const [imageFiles, setImageFiles] = useState<ImageFileData[]>([])
  const [uploadedFileNames, setUploadedFileNames] = useState<string[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setFileLoading(true)
    setMessage(null)
    try {
      const newImages: ImageFileData[] = []
      const newNames: string[] = []
      for (const file of files) {
        const category = getFileCategory(file)
        if (category === 'pdf') {
          const extracted = await extractTextFromPDF(file)
          setText((prev) => prev ? `${prev}\n\n${extracted}` : extracted)
          newNames.push(`${file.name}（テキスト抽出済み）`)
        } else if (category === 'excel') {
          const extracted = await extractTextFromExcel(file)
          setText((prev) => prev ? `${prev}\n\n${extracted}` : extracted)
          newNames.push(`${file.name}（テキスト抽出済み）`)
        } else if (category === 'word') {
          const extracted = await extractTextFromWord(file)
          setText((prev) => prev ? `${prev}\n\n${extracted}` : extracted)
          newNames.push(`${file.name}（テキスト抽出済み）`)
        } else if (category === 'image') {
          const imgData = await imageFileToBase64(file)
          newImages.push(imgData)
          newNames.push(file.name)
        } else {
          setMessage({ type: 'error', text: `${file.name} はPDF・Excel・Word・画像ファイルを選択してください` })
        }
      }
      setImageFiles((prev) => [...prev, ...newImages])
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
    setImageFiles((prev) => {
      const namesBefore = uploadedFileNames.slice(0, index)
      const imageIndexOffset = namesBefore.filter((n) => !n.includes('テキスト抽出済み')).length
      if (uploadedFileNames[index]?.includes('テキスト抽出済み')) return prev
      return prev.filter((_, i) => i !== imageIndexOffset)
    })
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCandidate(id, dataEnv),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
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

  const { data: isImportActive } = useQuery({
    queryKey: ['importActive'],
    queryFn: getIsImportActive,
    refetchInterval: 30_000,
  })

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ['candidates', dataEnv],
    queryFn: () => fetchCandidates(dataEnv),
    refetchInterval: isImportActive ? 30_000 : false,
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
      const analyzed = await ai.analyzeCandidate({
        rawText,
        imageFiles: imageFiles.length > 0 ? imageFiles : undefined,
      })
      return upsertCandidate({ analyzed, rawText, createdBy: nickname, dataEnv })
    },
    onSuccess: (candidate) => {
      queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
      setText('')
      setImageFiles([])
      setUploadedFileNames([])
      setShowRegisterModal(false)
      const msg = candidate.duplicate_flag
        ? `登録完了（重複の疑いフラグあり）: ${candidate.name}`
        : `登録完了: ${candidate.name}`
      setMessage({ type: 'success', text: msg })
      setSelectedId(candidate.id)
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
    },
  })

  const selectedCandidate = candidates.find((c: Candidate) => c.id === selectedId) ?? null

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
          }}
        />
      )}

      {demoUiEnabled && dataEnv === 'demo' && (
        <DemoSeedPanel
          nickname={nickname}
          createdByLabel="デモ人材"
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['projects', 'all', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['projects', 'open', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['submission-stats', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-projects', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-candidates', dataEnv] })
          }}
        />
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
                  disabled={fileLoading || mutation.isPending}
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
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button
                onClick={() => { setShowRegisterModal(false); setMessage(null) }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={() => { setMessage(null); mutation.mutate(text) }}
                disabled={(!text.trim() && imageFiles.length === 0) || mutation.isPending || fileLoading}
                className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {mutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
                {mutation.isPending ? 'AI解析中...' : '解析して登録'}
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
            登録済み人材（{searchQuery.trim() ? `${filteredCandidates.length} / ${candidates.length}` : candidates.length}件）
          </h2>
          <button
            type="button"
            onClick={() => { setMessage(null); setShowRegisterModal(true) }}
            className="flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-700 transition-colors shrink-0"
          >
            <UserPlus size={15} />
            新規登録
          </button>
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

        {message && (
          <div className={`mx-4 mt-3 text-sm rounded-lg px-3 py-2 ${message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {message.text}
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-gray-400 p-4">読み込み中...</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">まだ登録されていません</p>
        ) : filteredCandidates.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">「{searchQuery}」に一致する人材が見つかりません</p>
        ) : (
          <div className="flex flex-col md:flex-row">
            {/* Left: candidate list（モバイルで詳細表示中は非表示） */}
            <div className={`w-full md:w-64 lg:w-72 shrink-0 border-b md:border-b-0 md:border-r border-gray-100 overflow-y-auto md:max-h-[640px] ${selectedId ? 'hidden md:block' : ''}`}>
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
                    onClick={() => setSelectedId(isSelected ? null : c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
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
            </div>

            {/* Right: detail panel */}
            <div className="flex-1 overflow-y-auto md:max-h-[640px]">
              {selectedCandidate ? (
                <div className="p-4 space-y-4">
                  {/* モバイル用「一覧に戻る」ボタン */}
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
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
                            {(selectedCandidate as unknown as { from_company?: string }).from_company}
                          </span>
                        )}
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
                            href={resumeLink}
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
                        <a
                          href={selectedCandidate.box_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-orange-200 rounded-lg text-orange-600 hover:bg-orange-50 transition-colors"
                          title="Box経歴書を開く"
                        >
                          <ExternalLink size={14} />
                          Box{selectedCandidate.box_status === 'pending' ? '（処理待ち）' : selectedCandidate.box_status === 'enriched' ? '' : ''}
                        </a>
                      )}
                      {getRaw(selectedCandidate).from && (
                        <a
                          href={`mailto:${getRaw(selectedCandidate).from}?subject=Re: ${encodeURIComponent(getRaw(selectedCandidate).subject ?? '')}`}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                          title="返信"
                        >
                          <Reply size={14} />
                          返信
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingCandidate(selectedCandidate)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                        title="編集"
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
                  <CandidateProfileFields c={selectedCandidate} isExpanded detailMode />
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
    </div>
  )
}
