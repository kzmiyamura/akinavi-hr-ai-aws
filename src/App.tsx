import { lazy, Suspense, useEffect, useMemo, useState, Component } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNickname } from './hooks/useNickname'
import { NicknameModal } from './components/NicknameModal'
import { Layout } from './components/Layout'
import type { Page } from './components/Layout'
import { MatchingPage } from './pages/MatchingPage'
import { AuthCallbackPage } from './pages/AuthCallbackPage'

const CandidatePage = lazy(() => import('./pages/CandidatePage').then(m => ({ default: m.CandidatePage })))
const ProjectPage = lazy(() => import('./pages/ProjectPage').then(m => ({ default: m.ProjectPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const CandidateDetailPage = lazy(() => import('./pages/CandidateDetailPage').then(m => ({ default: m.CandidateDetailPage })))
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage').then(m => ({ default: m.ProjectDetailPage })))
import type { DataEnv } from './lib/dataEnv'
import {
  applyDemoKeyFromUrlToggle,
  getDemoUiEnabled,
  readStoredDataEnv,
  writeStoredDataEnv,
} from './lib/dataEnv'

class TabErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center p-10 gap-4 text-center">
          <p className="text-red-600 font-medium">ページの読み込みに失敗しました</p>
          <p className="text-xs text-gray-400 max-w-sm break-all">{this.state.error.message}</p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
          >
            再読み込み
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 3,       // 3分間はキャッシュ利用（タブ切替で再フェッチしない）
      refetchOnWindowFocus: false,     // ウィンドウフォーカス時の自動再フェッチ無効
    },
  },
})

type DetailView =
  | { kind: 'candidate'; id: string }
  | { kind: 'project'; id: string }

function stripDemoKeyQueryParams() {
  try {
    const url = new URL(window.location.href)
    if (
      !url.searchParams.has('demo') &&
      !url.searchParams.has('demoKey') &&
      !url.searchParams.has('demo_key')
    ) {
      return
    }
    url.searchParams.delete('demo')
    url.searchParams.delete('demoKey')
    url.searchParams.delete('demo_key')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    /* ignore */
  }
}

function AppInner() {
  // /auth/callback ルートは認証コールバック専用ページ
  if (window.location.pathname === '/auth/callback') {
    return <AuthCallbackPage />
  }

  const { nickname, saveNickname, clearNickname } = useNickname()
  const [tabPage, setTabPage] = useState<Page>('matching')
  const [detail, setDetail] = useState<DetailView | null>(null)

  const demoUnlockInitially = useMemo(() => getDemoUiEnabled(), [])
  const [demoUiEnabled, setDemoUiEnabled] = useState(demoUnlockInitially)

  const [dataEnv, setDataEnv] = useState<DataEnv>(() => {
    const stored = readStoredDataEnv()
    if (demoUnlockInitially) return stored ?? 'demo'
    return stored === 'demo' ? 'prod' : (stored ?? 'prod')
  })

  useEffect(() => {
    const r = applyDemoKeyFromUrlToggle()
    if (r === 'absent') return
    if (r === 'invalid') {
      stripDemoKeyQueryParams()
      return
    }
    if (r === 'unlocked') {
      setDemoUiEnabled(true)
      setDataEnv('demo')
      writeStoredDataEnv('demo')
      stripDemoKeyQueryParams()
      return
    }
    // locked: 本番固定・デモ選択不可
    setDemoUiEnabled(false)
    setDataEnv('prod')
    writeStoredDataEnv('prod')
    stripDemoKeyQueryParams()
  }, [])

  useEffect(() => {
    if (!demoUiEnabled && dataEnv === 'demo') {
      setDataEnv('prod')
      writeStoredDataEnv('prod')
    }
  }, [demoUiEnabled, dataEnv])

  useEffect(() => {
    writeStoredDataEnv(dataEnv)
  }, [dataEnv])

  if (!nickname) {
    return <NicknameModal onSave={saveNickname} />
  }

  function handleNavigate(page: Page) {
    setTabPage(page)
    setDetail(null)
  }

  function openCandidateDetail(id: string) {
    setDetail({ kind: 'candidate', id })
  }

  function openProjectDetail(id: string) {
    setDetail({ kind: 'project', id })
  }

  const renderMain = () => {
    // タブ切替でアンマウントすると、MatchingPage 内の長時間mutationが中断される。
    // 常にマウントしつつ表示だけ切り替える。
    return (
      <>
        <div className={tabPage === 'matching' ? 'block' : 'hidden'}>
          <MatchingPage
            nickname={nickname}
            dataEnv={dataEnv}
            onOpenCandidateDetail={openCandidateDetail}
            onOpenProjectDetail={openProjectDetail}
          />
        </div>
        <TabErrorBoundary>
          <Suspense fallback={<div className="flex justify-center items-center p-10 text-gray-400 text-sm">読み込み中...</div>}>
            {tabPage === 'candidates' && (
              <CandidatePage
                nickname={nickname}
                dataEnv={dataEnv}
                demoUiEnabled={demoUiEnabled}
                onOpenCandidateDetail={openCandidateDetail}
              />
            )}
            {tabPage === 'projects' && (
              <ProjectPage nickname={nickname} dataEnv={dataEnv} demoUiEnabled={demoUiEnabled} onOpenProjectDetail={openProjectDetail} />
            )}
            {tabPage === 'settings' && (
              <SettingsPage demoUiEnabled={demoUiEnabled} />
            )}
          </Suspense>
        </TabErrorBoundary>
      </>
    )
  }

  return (
    <Layout
      activeTab={tabPage}
      onNavigate={handleNavigate}
      nickname={nickname}
      onClearNickname={clearNickname}
      dataEnv={dataEnv}
      demoUiEnabled={demoUiEnabled}
      onChangeDataEnv={setDataEnv}
    >
      {detail?.kind === 'candidate' ? (
        <Suspense fallback={<div className="flex justify-center items-center p-10 text-gray-400 text-sm">読み込み中...</div>}>
          <CandidateDetailPage
            candidateId={detail.id}
            nickname={nickname}
            dataEnv={dataEnv}
            onBack={() => setDetail(null)}
          />
        </Suspense>
      ) : detail?.kind === 'project' ? (
        <Suspense fallback={<div className="flex justify-center items-center p-10 text-gray-400 text-sm">読み込み中...</div>}>
          <ProjectDetailPage projectId={detail.id} nickname={nickname} dataEnv={dataEnv} onBack={() => setDetail(null)} />
        </Suspense>
      ) : (
        renderMain()
      )}
    </Layout>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  )
}
