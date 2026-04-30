import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Briefcase } from 'lucide-react'
import { ai } from '../lib/ai'
import { insertProject, fetchAllProjects } from '../lib/db/projects'
import type { Project } from '../lib/db/projects'

interface Props { nickname: string }

export function ProjectPage({ nickname }: Props) {
  const [text, setText] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const queryClient = useQueryClient()

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchAllProjects,
  })

  const mutation = useMutation({
    mutationFn: async (rawText: string) => {
      const analyzed = await ai.analyzeProject({ rawText })
      return insertProject({ analyzed, rawText, createdBy: nickname })
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setText('')
      setMessage({ type: 'success', text: `登録完了: ${project.title}` })
    },
    onError: (e) => {
      setMessage({ type: 'error', text: String(e) })
    },
  })

  const statusLabel: Record<Project['status'], string> = {
    open:   '募集中',
    filled: '充足',
    closed: 'クローズ',
  }
  const statusColor: Record<Project['status'], string> = {
    open:   'bg-green-100 text-green-700',
    filled: 'bg-gray-100 text-gray-500',
    closed: 'bg-red-100 text-red-500',
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
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
          {mutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Briefcase size={16} />}
          {mutation.isPending ? 'AI解析中...' : '解析して登録'}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-4">
          登録済み案件（{projects.length}件）
        </h2>
        {isLoading ? (
          <p className="text-sm text-gray-400">読み込み中...</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-gray-400">まだ登録されていません</p>
        ) : (
          <div className="space-y-3">
            {projects.map((p: Project) => (
              <div key={p.id} className="border border-gray-100 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800 text-sm">{p.title}</span>
                    <span className={`text-xs rounded px-2 py-0.5 ${statusColor[p.status]}`}>
                      {statusLabel[p.status]}
                    </span>
                  </div>
                  <span className="text-xs text-gray-300">{p.created_by}</span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {p.client ?? 'クライアント不明'}
                  {p.budget_min && ` ／ ${p.budget_min}〜${p.budget_max ?? '?'}万`}
                </p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {(p.required_skills as string[]).slice(0, 6).map((s) => (
                    <span key={s} className="text-xs bg-purple-50 text-purple-700 rounded px-1.5 py-0.5">{s}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
