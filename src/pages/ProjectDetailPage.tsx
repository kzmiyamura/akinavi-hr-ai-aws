import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Loader2 } from 'lucide-react'
import { fetchProjectById, invalidateProjectLists } from '../lib/db/projects'
import { ProjectProfileFields, ProjectEditModal } from './ProjectPage'
import type { DataEnv } from '../lib/dataEnv'

interface Props {
  projectId: string
  nickname: string
  dataEnv: DataEnv
  onBack: () => void
}

export function ProjectDetailPage({ projectId, nickname, dataEnv, onBack }: Props) {
  const queryClient = useQueryClient()
  const [editingOpen, setEditingOpen] = useState(false)

  const { data: project, isLoading, error, isError } = useQuery({
    queryKey: ['projects', dataEnv, projectId],
    queryFn: () => fetchProjectById(projectId, dataEnv),
  })

  function handleSaved() {
    queryClient.invalidateQueries({ queryKey: ['projects', dataEnv, projectId] })
    invalidateProjectLists(queryClient, dataEnv)
    setEditingOpen(false)
  }

  return (
    <div className="space-y-6">
      {project && editingOpen && (
        <ProjectEditModal
          project={project}
          nickname={nickname}
          dataEnv={dataEnv}
          onClose={() => setEditingOpen(false)}
          onSaved={handleSaved}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-2 bg-white hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft size={16} />
          戻る
        </button>
        {project && (
          <button
            type="button"
            onClick={() => setEditingOpen(true)}
            className="inline-flex items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <Pencil size={15} />
            編集
          </button>
        )}
      </div>

      {isLoading && (
        <p className="text-sm text-gray-400 flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" />
          読み込み中...
        </p>
      )}
      {isError && (
        <p className="text-sm text-red-600">{error instanceof Error ? error.message : String(error)}</p>
      )}
      {!isLoading && !isError && !project && (
        <p className="text-sm text-gray-500">案件が見つかりません（削除された可能性があります）。</p>
      )}
      {project && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 min-w-0">
          <ProjectProfileFields p={project} isExpanded={false} detailMode />
        </div>
      )}
    </div>
  )
}
