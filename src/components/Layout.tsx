import { Users, Briefcase, Star, History, AlertTriangle, LogOut, Activity } from 'lucide-react'

export type Page = 'candidates' | 'projects' | 'matching' | 'history' | 'duplicates' | 'monitor'

interface Props {
  currentPage: Page
  onNavigate: (page: Page) => void
  nickname: string
  onClearNickname: () => void
  children: React.ReactNode
}

const NAV_ITEMS: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: 'candidates', label: '人材登録', icon: <Users size={16} /> },
  { page: 'projects',   label: '案件登録', icon: <Briefcase size={16} /> },
  { page: 'matching',   label: 'マッチング', icon: <Star size={16} /> },
  { page: 'history',    label: '提案履歴', icon: <History size={16} /> },
  { page: 'duplicates', label: '重複管理', icon: <AlertTriangle size={16} /> },
  { page: 'monitor',    label: '解析監視', icon: <Activity size={16} /> },
]

export function Layout({ currentPage, onNavigate, nickname, onClearNickname, children }: Props) {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-blue-700">AkiNavi HR-AI</h1>
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>利用者: <strong className="text-gray-700">{nickname}</strong></span>
          <button
            onClick={onClearNickname}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition-colors"
            title="名前を変更する"
          >
            <LogOut size={13} />
            名前変更
          </button>
        </div>
      </header>

      {/* タブナビゲーション */}
      <nav className="bg-white border-b border-gray-200 px-4 flex gap-1 overflow-x-auto">
        {NAV_ITEMS.map(({ page, label, icon }) => (
          <button
            key={page}
            onClick={() => onNavigate(page)}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              currentPage === page
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </nav>

      {/* メインコンテンツ */}
      <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
