import { Users, Briefcase, Star, LogOut } from 'lucide-react'
import type { DataEnv } from '../lib/dataEnv'

export type Page = 'matching' | 'candidates' | 'projects'

interface Props {
  /** タブのハイライトに使う（詳細画面では戻り先のタブ） */
  activeTab: Page
  onNavigate: (page: Page) => void
  nickname: string
  onClearNickname: () => void
  dataEnv: DataEnv
  /** デモ環境（data_env=demo）のUIを出す（URLキー解除後） */
  demoUiEnabled: boolean
  onChangeDataEnv: (env: DataEnv) => void
  children: React.ReactNode
}

const NAV_ITEMS: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: 'matching', label: 'マッチング結果', icon: <Star size={16} className="shrink-0" /> },
  { page: 'candidates', label: '人材登録', icon: <Users size={16} className="shrink-0" /> },
  { page: 'projects', label: '案件登録', icon: <Briefcase size={16} className="shrink-0" /> },
]

export function Layout({
  activeTab,
  onNavigate,
  nickname,
  onClearNickname,
  dataEnv,
  demoUiEnabled,
  onChangeDataEnv,
  children,
}: Props) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="sticky top-0 z-50 bg-white shadow-sm">
        <header className="border-b border-gray-100 px-3 sm:px-4 py-2.5 sm:py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between max-w-4xl mx-auto w-full">
            <h1 className="text-base sm:text-lg font-bold text-blue-700 truncate min-w-0">
              AkiNavi HR-AI
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-500">
              <label className="flex items-center gap-1.5 shrink-0">
                <span className="text-gray-400">データ</span>
                <select
                  value={dataEnv}
                  onChange={(e) => onChangeDataEnv(e.target.value as DataEnv)}
                  disabled={!demoUiEnabled}
                  title={
                    demoUiEnabled
                      ? '参照する data_env（demo はデモ解除後のみ）'
                      : 'デモ環境を見るには URL に demoKey を付与してください'
                  }
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs sm:text-sm bg-white text-gray-700 disabled:opacity-60"
                >
                  <option value="prod">本番相当（prod）</option>
                  <option value="demo" disabled={!demoUiEnabled}>
                    デモ（demo）
                  </option>
                </select>
              </label>
              <span className="min-w-0 break-all">
                利用者: <strong className="text-gray-700">{nickname}</strong>
              </span>
              <button
                type="button"
                onClick={onClearNickname}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition-colors shrink-0"
                title="名前を変更する"
              >
                <LogOut size={13} />
                名前変更
              </button>
            </div>
          </div>
        </header>

        <nav className="border-b border-gray-200 bg-white max-w-4xl mx-auto w-full px-1 sm:px-4">
          <div className="flex w-full">
            {NAV_ITEMS.map(({ page, label, icon }) => (
              <button
                key={page}
                type="button"
                onClick={() => onNavigate(page)}
                className={`flex flex-1 flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 px-1.5 sm:px-4 py-2.5 sm:py-3 text-[11px] sm:text-sm font-medium border-b-2 transition-colors min-w-0 ${
                  activeTab === page
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {icon}
                <span className="text-center leading-tight sm:whitespace-nowrap">{label}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>

      <main className="flex-1 w-full max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 min-w-0">
        {children}
      </main>
    </div>
  )
}
