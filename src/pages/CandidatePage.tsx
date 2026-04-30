import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, UserPlus, RefreshCw, Trash2 } from 'lucide-react'
import { ai } from '../lib/ai'
import { upsertCandidate, fetchCandidates, deleteCandidate } from '../lib/db/candidates'
import type { Candidate } from '../lib/db/candidates'

interface SkillsByCategory {
  languages: string[]
  frameworks: string[]
  os: string[]
  others: string[]
}

interface RawProfile {
  skillsByCategory?: SkillsByCategory
  skillsWithYears?: { skill: string; years: number }[]
  roles?: string[]
  industries?: string[]
}

function getRaw(c: Candidate): RawProfile {
  return (c.raw_profile ?? {}) as RawProfile
}

const CATEGORY_STYLE: Record<keyof SkillsByCategory, { label: string; badge: string }> = {
  languages: { label: '言語', badge: 'bg-blue-50 text-blue-700' },
  frameworks: { label: 'FW',   badge: 'bg-green-50 text-green-700' },
  os:         { label: 'OS',   badge: 'bg-amber-50 text-amber-700' },
  others:     { label: 'その他', badge: 'bg-gray-100 text-gray-600' },
}

interface Props { nickname: string }

export function CandidatePage({ nickname }: Props) {
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const queryClient = useQueryClient()

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

  const mutation = useMutation({
    mutationFn: async (rawText: string) => {
      const analyzed = await ai.analyzeCandidate({ rawText })
      // 既存候補と名前・スキルの類似チェックは AI のマッチング判定に委ねる
      // ここでは単純に duplicateSuspected=false で登録（Phase 3 の重複管理で対応）
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
        <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <RefreshCw size={18} className="text-gray-500" />
          登録済み人材（{candidates.length}件）
        </h2>
        {isLoading ? (
          <p className="text-sm text-gray-400">読み込み中...</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-gray-400">まだ登録されていません</p>
        ) : (
          <div className="space-y-3">
            {candidates.map((c: Candidate) => (
              <div key={c.id} className="border border-gray-100 rounded-lg p-4 flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800 text-sm">{c.name}</span>
                    {c.duplicate_flag && (
                      <span className="text-xs bg-yellow-100 text-yellow-700 rounded px-2 py-0.5">重複の疑い</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {c.email ?? 'メールなし'} ／ 経験{c.experience_years ?? '?'}年
                  </p>
                  {(() => {
                    const raw = getRaw(c)
                    const { skillsByCategory: sbc, skillsWithYears, roles, industries } = raw
                    const yearsMap = new Map((skillsWithYears ?? []).map(({ skill, years }) => [skill, years]))

                    return (
                      <div className="space-y-1 mt-1.5">
                        {/* 役割・業界 */}
                        {(roles ?? []).length > 0 && (
                          <div className="flex flex-wrap gap-1 items-center">
                            <span className="text-xs text-gray-400 w-10 shrink-0">役割</span>
                            {(roles ?? []).map((r) => (
                              <span key={r} className="text-xs bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5">{r}</span>
                            ))}
                          </div>
                        )}
                        {(industries ?? []).length > 0 && (
                          <div className="flex flex-wrap gap-1 items-center">
                            <span className="text-xs text-gray-400 w-10 shrink-0">業界</span>
                            {(industries ?? []).map((i) => (
                              <span key={i} className="text-xs bg-teal-50 text-teal-700 rounded px-1.5 py-0.5">{i}</span>
                            ))}
                          </div>
                        )}
                        {/* スキル（カテゴリ別） */}
                        {sbc ? (
                          (Object.keys(CATEGORY_STYLE) as (keyof SkillsByCategory)[]).map((key) => {
                            const items = sbc[key]
                            if (!items || items.length === 0) return null
                            const { label, badge } = CATEGORY_STYLE[key]
                            const shown = key === 'others' ? items.slice(0, 5) : items
                            return (
                              <div key={key} className="flex flex-wrap gap-1 items-center">
                                <span className="text-xs text-gray-400 w-10 shrink-0">{label}</span>
                                {shown.map((s) => {
                                  const yr = yearsMap.get(s)
                                  return (
                                    <span key={s} className={`text-xs rounded px-1.5 py-0.5 ${badge}`}>
                                      {s}{yr ? <span className="opacity-60 ml-0.5">{yr}y</span> : null}
                                    </span>
                                  )
                                })}
                                {key === 'others' && items.length > 5 && (
                                  <span className="text-xs text-gray-400">+{items.length - 5}</span>
                                )}
                              </div>
                            )
                          })
                        ) : (
                          // 旧レコード用フォールバック
                          <div className="flex flex-wrap gap-1">
                            {(c.skills as string[]).slice(0, 6).map((s) => (
                              <span key={s} className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{s}</span>
                            ))}
                            {(c.skills as string[]).length > 6 && (
                              <span className="text-xs text-gray-400">+{(c.skills as string[]).length - 6}</span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
                <div className="flex items-center gap-3 ml-4 shrink-0">
                  <span className="text-xs text-gray-300">{c.created_by}</span>
                  <button
                    onClick={() => handleDelete(c)}
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
