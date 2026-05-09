import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Briefcase, RefreshCw, Search, ChevronDown, ChevronUp, Pencil, Trash2, X, MapPin, Wifi, Mail, Paperclip, ChevronRight } from 'lucide-react'
import { ai } from '../lib/ai'
import {
  insertProject,
  fetchAllProjects,
  updateProject,
  deleteProject,
  projectsQueryKeys,
  invalidateProjectLists,
} from '../lib/db/projects'
import type { Project } from '../lib/db/projects'
import type { DataEnv } from '../lib/dataEnv'
import type { ImageFileData } from '../lib/ai/types'
import { DemoSeedPanel } from '../components/DemoSeedPanel'
import { extractTextFromPDF, extractTextFromExcel, extractTextFromWord, imageFileToBase64, getFileCategory } from '../lib/fileParser'
import { getIsImportActive } from '../lib/db/emailSettings'

interface Props {
  nickname: string
  dataEnv: DataEnv
  demoUiEnabled?: boolean
  onOpenProjectDetail?: (projectId: string) => void
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function splitComma(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

function toComma(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return (items as unknown[]).map(String).filter(Boolean).join(', ')
}

interface EditForm {
  title: string
  client: string
  description: string
  requiredSkills: string
  niceToHaveSkills: string
  budgetMin: string
  budgetMax: string
  startDate: string
  endDate: string
  workLocation: string
  remotePolicy: string
  contractType: string
  headcount: string
  workload: string
  settlementMin: string
  settlementMax: string
  roleSummary: string
  industry: string
  status: Project['status']
}

function toEditForm(p: Project): EditForm {
  const rawNice = (p.raw_data as { niceToHaveSkills?: unknown })?.niceToHaveSkills
  return {
    title: p.title ?? '',
    client: p.client ?? '',
    description: p.description ?? '',
    requiredSkills: (p.required_skills as string[]).join(', '),
    niceToHaveSkills: toComma(rawNice),
    budgetMin: p.budget_min != null ? String(p.budget_min) : '',
    budgetMax: p.budget_max != null ? String(p.budget_max) : '',
    startDate: p.start_date ?? '',
    endDate: p.end_date ?? '',
    workLocation: p.work_location ?? '',
    remotePolicy: p.remote_policy ?? '',
    contractType: p.contract_type ?? '',
    headcount: p.headcount != null ? String(p.headcount) : '',
    workload: p.workload ?? '',
    settlementMin: p.settlement_min != null ? String(p.settlement_min) : '',
    settlementMax: p.settlement_max != null ? String(p.settlement_max) : '',
    roleSummary: p.role_summary ?? '',
    industry: p.industry ?? '',
    status: p.status,
  }
}

export function ProjectProfileFields({
  p,
  isExpanded,
  onToggleExpand,
  detailMode = false,
}: {
  p: Project
  isExpanded: boolean
  onToggleExpand?: () => void
  detailMode?: boolean
}) {
  const rawNice = (p.raw_data as { niceToHaveSkills?: unknown })?.niceToHaveSkills
  const nice = Array.isArray(rawNice) ? rawNice.map(String).filter(Boolean) : []
  const required = (p.required_skills as string[]) ?? []
  const raw = (p.raw_data ?? {}) as { from?: unknown; subject?: unknown }
  const mailFrom = typeof raw.from === 'string' ? raw.from : null
  const mailSubject = typeof raw.subject === 'string' ? raw.subject : null
  const needsToggle = !detailMode && ((required.length + nice.length) > 12 || (p.description?.length ?? 0) > 240)
  const hasLocation = Boolean(p.work_location) || Boolean(p.remote_policy)
  const showAll = detailMode || isExpanded

  const statusLabel: Record<Project['status'], string> = {
    open: '募集中',
    filled: '充足',
    closed: 'クローズ',
  }
  const statusColor: Record<Project['status'], string> = {
    open: 'bg-green-100 text-green-700',
    filled: 'bg-gray-100 text-gray-500',
    closed: 'bg-red-100 text-red-500',
  }

  return (
    <div className="flex-1 min-w-0 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-gray-800 text-sm">{p.title}</span>
        <span className={`text-xs rounded px-2 py-0.5 ${statusColor[p.status]}`}>
          {statusLabel[p.status]}
        </span>
      </div>
      <div className="text-xs text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{p.client ?? 'クライアント不明'}</span>
        {p.created_at && <span>登録: {formatDate(p.created_at)}</span>}
        <span className="text-gray-300">{p.created_by}</span>
      </div>

      {needsToggle && onToggleExpand && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          title={isExpanded ? '折りたたむ' : '展開'}
        >
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {isExpanded ? '閉じる' : 'もっと'}
        </button>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
        {p.industry && <span>業界: {p.industry}</span>}
        {p.contract_type && <span>{p.contract_type}</span>}
        {p.headcount != null && <span>募集: {p.headcount}名</span>}
        {p.budget_min != null && (
          <span>予算: {p.budget_min}〜{p.budget_max ?? '?'}万</span>
        )}
        {p.start_date && <span>開始: {p.start_date}</span>}
        {p.end_date && <span>終了: {p.end_date}</span>}
        {p.workload && <span>稼働: {p.workload}</span>}
        {(p.settlement_min != null || p.settlement_max != null) && (
          <span>
            精算: {p.settlement_min ?? '?'}〜{p.settlement_max ?? '?'}h
          </span>
        )}
        {p.role_summary && <span>役割: {p.role_summary}</span>}
      </div>

      {hasLocation && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
          {p.work_location && (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <MapPin size={11} />
              {p.work_location}
            </span>
          )}
          {p.remote_policy && (
            <span className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 rounded px-1.5 py-0.5">
              <Wifi size={10} />
              {p.remote_policy}
            </span>
          )}
        </div>
      )}

      <div className="mt-1.5 border-t border-gray-50 pt-1.5 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
            <Mail size={10} />
            受信: {p.created_at ? formatDate(p.created_at) : '—'}
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
          最終更新: {formatDate(p.updated_at)}
          {p.updated_by ? ` by ${p.updated_by}` : ''}
        </div>
      </div>

      {p.description && (
        <p className="text-xs text-gray-500 leading-relaxed whitespace-pre-wrap">
          {showAll ? p.description : (p.description.length > 240 ? `${p.description.slice(0, 240)}…` : p.description)}
        </p>
      )}

      {(required.length > 0 || nice.length > 0) && (
        <div className="space-y-1">
          {required.length > 0 && (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-gray-400 w-12 shrink-0">必須</span>
              {(showAll ? required : required.slice(0, 10)).map((s) => (
                <span key={s} className="text-xs bg-purple-50 text-purple-700 rounded px-1.5 py-0.5">{s}</span>
              ))}
              {!showAll && required.length > 10 && (
                <span className="text-xs text-gray-400">+{required.length - 10}</span>
              )}
            </div>
          )}
          {nice.length > 0 && (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-gray-400 w-12 shrink-0">尚可</span>
              {(showAll ? nice : nice.slice(0, 10)).map((s) => (
                <span key={s} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{s}</span>
              ))}
              {!showAll && nice.length > 10 && (
                <span className="text-xs text-gray-400">+{nice.length - 10}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface EditModalProps {
  project: Project
  nickname: string
  dataEnv: DataEnv
  onClose: () => void
  onSaved: () => void
}

export function ProjectEditModal({ project, nickname, dataEnv, onClose, onSaved }: EditModalProps) {
  const [form, setForm] = useState<EditForm>(() => toEditForm(project))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const niceToHaveSkills = splitComma(form.niceToHaveSkills)
      await updateProject({
        id: project.id,
        dataEnv,
        title: form.title.trim() || '案件',
        client: form.client.trim() || null,
        description: form.description ?? '',
        required_skills: splitComma(form.requiredSkills),
        budget_min: form.budgetMin !== '' ? Number(form.budgetMin) : null,
        budget_max: form.budgetMax !== '' ? Number(form.budgetMax) : null,
        start_date: form.startDate.trim() || null,
        end_date: form.endDate.trim() || null,
        work_location: form.workLocation.trim() || null,
        remote_policy: form.remotePolicy.trim() || null,
        contract_type: form.contractType.trim() || null,
        headcount: form.headcount !== '' ? Number(form.headcount) : null,
        workload: form.workload.trim() || null,
        settlement_min: form.settlementMin !== '' ? Number(form.settlementMin) : null,
        settlement_max: form.settlementMax !== '' ? Number(form.settlementMax) : null,
        role_summary: form.roleSummary.trim() || null,
        industry: form.industry.trim() || null,
        status: form.status,
        raw_data: {
          ...(project.raw_data ?? {}),
          niceToHaveSkills,
        },
        updated_by: nickname,
      })
      onSaved()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
  const labelCls = 'text-xs font-medium text-gray-600'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8 px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-800">案件情報の編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[75vh] overflow-y-auto">
          {error && <p className="text-sm text-red-600">{error}</p>}

          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">基本情報</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>案件名 *</label>
                <input className={inputCls} value={form.title} onChange={e => setField('title', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>クライアント</label>
                <input className={inputCls} value={form.client} onChange={e => setField('client', e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <label className={labelCls}>概要</label>
              <textarea className={inputCls} rows={4} value={form.description} onChange={e => setField('description', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>状態</label>
                <select className={inputCls} value={form.status} onChange={e => setField('status', e.target.value as EditForm['status'])}>
                  <option value="open">募集中</option>
                  <option value="filled">充足</option>
                  <option value="closed">クローズ</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className={labelCls}>業界</label>
                <input className={inputCls} value={form.industry} onChange={e => setField('industry', e.target.value)} />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">スキル</h3>
            <div className="space-y-1">
              <label className={labelCls}>必須（カンマ区切り）</label>
              <input className={inputCls} value={form.requiredSkills} onChange={e => setField('requiredSkills', e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>尚可（カンマ区切り）</label>
              <input className={inputCls} value={form.niceToHaveSkills} onChange={e => setField('niceToHaveSkills', e.target.value)} />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">条件</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>単価（下限・万円）</label>
                <input className={inputCls} type="number" min={0} value={form.budgetMin} onChange={e => setField('budgetMin', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>単価（上限・万円）</label>
                <input className={inputCls} type="number" min={0} value={form.budgetMax} onChange={e => setField('budgetMax', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>開始（YYYY-MM-DD）</label>
                <input className={inputCls} value={form.startDate} onChange={e => setField('startDate', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>終了（YYYY-MM-DD）</label>
                <input className={inputCls} value={form.endDate} onChange={e => setField('endDate', e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>勤務地</label>
                <input className={inputCls} value={form.workLocation} onChange={e => setField('workLocation', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>リモート/出社</label>
                <input className={inputCls} value={form.remotePolicy} onChange={e => setField('remotePolicy', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>契約形態</label>
                <input className={inputCls} value={form.contractType} onChange={e => setField('contractType', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>募集人数</label>
                <input className={inputCls} type="number" min={0} value={form.headcount} onChange={e => setField('headcount', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>稼働</label>
                <input className={inputCls} value={form.workload} onChange={e => setField('workload', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>役割</label>
                <input className={inputCls} value={form.roleSummary} onChange={e => setField('roleSummary', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>精算下限（h）</label>
                <input className={inputCls} type="number" min={0} value={form.settlementMin} onChange={e => setField('settlementMin', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>精算上限（h）</label>
                <input className={inputCls} type="number" min={0} value={form.settlementMax} onChange={e => setField('settlementMax', e.target.value)} />
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProjectPage({ nickname, dataEnv, demoUiEnabled = false, onOpenProjectDetail: _onOpenProjectDetail }: Props) {
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingProject, setEditingProject] = useState<Project | null>(null)
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

  const { data: isImportActive } = useQuery({
    queryKey: ['importActive'],
    queryFn: getIsImportActive,
    refetchInterval: 30_000,
  })

  const { data: projects = [], isLoading } = useQuery({
    queryKey: projectsQueryKeys.all(dataEnv),
    queryFn: () => fetchAllProjects(dataEnv),
    refetchInterval: isImportActive ? 30_000 : false,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProject(id, dataEnv),
    onSuccess: () => {
      invalidateProjectLists(queryClient, dataEnv)
      setDeletingId(null)
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
      setDeletingId(null)
    },
  })

  function handleDelete(p: Project) {
    if (!window.confirm(`「${p.title}」を削除しますか？この操作は元に戻せません。`)) return
    setDeletingId(p.id)
    deleteMutation.mutate(p.id)
  }

  const mutation = useMutation({
    mutationFn: async (rawText: string) => {
      const analyzed = await ai.analyzeProject({
        rawText,
        imageFiles: imageFiles.length > 0 ? imageFiles : undefined,
      })
      return insertProject({ analyzed, rawText, createdBy: nickname, dataEnv })
    },
    onSuccess: (project) => {
      invalidateProjectLists(queryClient, dataEnv)
      setText('')
      setImageFiles([])
      setUploadedFileNames([])
      setMessage({ type: 'success', text: `登録完了: ${project.title}` })
      setSelectedId(project.id)
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
    },
  })

  const selectedProject = projects.find((p: Project) => p.id === selectedId) ?? null

  const filteredProjects = projects.filter((p: Project) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    const rawNice = (p.raw_data as { niceToHaveSkills?: unknown })?.niceToHaveSkills
    const nice = Array.isArray(rawNice) ? rawNice.map(String) : []
    const targets = [
      p.title,
      p.client,
      p.description,
      ...(p.required_skills as string[]),
      ...nice,
      p.work_location,
      p.remote_policy,
      p.contract_type,
      p.role_summary,
      p.industry,
      p.workload,
    ].filter(Boolean).map((s) => String(s).toLowerCase())
    return targets.some((t) => t.includes(q))
  })

  return (
    <div className="space-y-6">
      {/* 編集モーダル */}
      {editingProject && (
        <ProjectEditModal
          project={editingProject}
          nickname={nickname}
          dataEnv={dataEnv}
          onClose={() => setEditingProject(null)}
          onSaved={() => {
            setEditingProject(null)
            invalidateProjectLists(queryClient, dataEnv)
          }}
        />
      )}
      {demoUiEnabled && dataEnv === 'demo' && (
        <DemoSeedPanel
          nickname={nickname}
          createdByLabel="デモ案件"
          onDone={() => {
            invalidateProjectLists(queryClient, dataEnv)
            queryClient.invalidateQueries({ queryKey: ['candidates', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['submission-stats', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-projects', dataEnv] })
            queryClient.invalidateQueries({ queryKey: ['matching-submissions-by-candidates', dataEnv] })
          }}
        />
      )}
      <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 space-y-4 min-w-0">
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
          <Briefcase size={18} className="text-blue-600" />
          案件を登録
        </h2>
        <p className="text-sm text-gray-500">
          案件概要・要件定義書・メール本文などのテキストを貼り付けてください。
          AI が自動解析して登録します。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="テキストをここに貼り付け..."
          rows={8}
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
        {/* ファイルアップロード */}
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
        <button
          onClick={() => { setMessage(null); mutation.mutate(text) }}
          disabled={(!text.trim() && imageFiles.length === 0) || mutation.isPending || fileLoading}
          className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Briefcase size={16} />}
          {mutation.isPending ? 'AI解析中...' : '解析して登録'}
        </button>
      </div>

      {/* 案件一覧 - Split layout */}
      <div className="bg-white rounded-xl border border-gray-200 min-w-0">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-wrap">
          <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <RefreshCw size={18} className="text-gray-500" />
            登録済み案件（{searchQuery.trim() ? `${filteredProjects.length} / ${projects.length}` : projects.length}件）
          </h2>
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="案件名・必須/尚可スキル・勤務地・契約形態などで検索..."
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
          <p className="text-sm text-gray-400 p-4">読み込み中...</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">まだ登録されていません</p>
        ) : filteredProjects.length === 0 ? (
          <p className="text-sm text-gray-400 p-4">「{searchQuery}」に一致する案件が見つかりません</p>
        ) : (
          <div className="flex flex-col md:flex-row">
            {/* Left: project list */}
            <div className="w-full md:w-64 lg:w-72 shrink-0 border-b md:border-b-0 md:border-r border-gray-100 overflow-y-auto md:max-h-[640px]">
              {filteredProjects.map((p: Project) => {
                const statusLabel: Record<Project['status'], string> = {
                  open: '募集中',
                  filled: '充足',
                  closed: 'クローズ',
                }
                const statusColor: Record<Project['status'], string> = {
                  open: 'bg-green-100 text-green-700',
                  filled: 'bg-gray-100 text-gray-500',
                  closed: 'bg-red-100 text-red-500',
                }
                const isSelected = selectedId === p.id
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(isSelected ? null : p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedId(isSelected ? null : p.id)
                      }
                    }}
                    className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-50 last:border-0 transition-colors ${
                      isSelected
                        ? 'bg-blue-50 border-l-2 border-l-blue-500'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{p.title}</div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className={`text-[10px] rounded px-1.5 py-0.5 ${statusColor[p.status]}`}>
                          {statusLabel[p.status]}
                        </span>
                        {p.client && (
                          <span className="text-xs text-gray-400 truncate">{p.client}</span>
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
              {selectedProject ? (
                <div className="p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-semibold text-gray-800">{selectedProject.title}</h3>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setEditingProject(selectedProject)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-blue-600 hover:border-blue-300 transition-colors"
                        title="編集"
                      >
                        <Pencil size={14} />
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(selectedProject)}
                        disabled={deletingId === selectedProject.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:text-red-600 hover:border-red-300 transition-colors disabled:opacity-50"
                        title="削除"
                      >
                        {deletingId === selectedProject.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Trash2 size={14} />}
                        削除
                      </button>
                    </div>
                  </div>
                  <ProjectProfileFields p={selectedProject} isExpanded detailMode />
                </div>
              ) : (
                <div className="flex items-center justify-center h-32 md:h-full text-sm text-gray-400 p-8 text-center">
                  ← 左のリストから案件を選択すると詳細が表示されます
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
