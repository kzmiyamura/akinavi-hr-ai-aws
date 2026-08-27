import { lazy, Suspense, useEffect, useMemo, useState, Component } from 'react'
import type { ReactNode } from 'react'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import {
  PERSIST_KEY,
  PERSIST_MAX_AGE_MS,
  persistBuster,
  shouldPersistQuery,
} from './lib/queryPersist'
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
const HeatmapPage = lazy(() => import('./pages/HeatmapPage').then(m => ({ default: m.HeatmapPage })))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage').then(m => ({ default: m.NotificationsPage })))
import type { DataEnv } from './lib/dataEnv'
import {
  applyDemoKeyFromUrlToggle,
  getDemoUiEnabled,
  readStoredDataEnv,
  writeStoredDataEnv,
} from './lib/dataEnv'
import { projectsQueryKeys } from './lib/db/projects'

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
      staleTime: 1000 * 60 * 10,      // 10分間はキャッシュ利用（タブ切替で再フェッチしない）
      // 画面から消えたクエリを捨てるまでの時間。既定5分だと案件↔人材モードを
      // 往復するたびに引き直しになる。egress が逼迫しているので長めに持つ（2026-08-14）
      gcTime: 1000 * 60 * 60,
      refetchOnWindowFocus: false,     // ウィンドウフォーカス時の自動再フェッチ無効
      refetchOnMount: false,           // 再マウントで staleTime 内なら引き直さない
      retry: 1,                        // 既定3回。失敗クエリの再試行も転送量になる
    },
  },
})

// キャッシュを localStorage に載せる（2026-08-17）。
// メモリのみだったため、F5・タブの開き直しのたびに一覧を引き直していた。
// 営業5人運用だと Free Plan の egress 5GB/月に対して現実的でないため永続化する。
// 容量オーバー時は古いクエリから捨てて書き直す（removeOldestQuery）。
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: PERSIST_KEY,
  throttleTime: 1000,
  retry: ({ persistedClient, error }) => {
    // localStorage の容量（約5MB）を超えたときのフォールバック。
    // 古い順に1つ落として再試行し、それでも入らなければ諦める（キャッシュ無しで動く）
    console.warn('[queryPersist] 保存に失敗したため古いクエリを捨てて再試行します', error)
    const queries = persistedClient.clientState.queries
    if (queries.length <= 1) return undefined
    return {
      ...persistedClient,
      clientState: { ...persistedClient.clientState, queries: queries.slice(1) },
    }
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

  // マッチングタブへ切り替え時にプロジェクト一覧を強制更新（案件追加後の未反映対策）
  useEffect(() => {
    if (tabPage === 'matching') {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.open(dataEnv) })
    }
  }, [tabPage, dataEnv])

  // 人材タブの先読み prefetch は 2026-08-17 に削除した。
  // キーが ['candidates-paged', dataEnv] の2要素で、CandidatePage が実際に使うキー
  // （['candidates-paged', dataEnv, activePrioritySkills] の3要素・CandidatePage.tsx:1107）と
  // 一致していなかったため、**誰にも読まれないまま毎回100件を引いていた**。
  // 先読みの速度効果はゼロで、ページ読み込みのたびに約130KB を捨てていたことになる。
  // 人材タブを開いたときは CandidatePage 自身のクエリが取得する（従来どおり）。

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
            {/* タブ切替でアンマウントすると絞り込み等のローカル状態が消えるため、常にマウントしつつ表示だけ切り替える */}
            <div className={tabPage === 'candidates' ? 'block' : 'hidden'}>
              <CandidatePage
                nickname={nickname}
                dataEnv={dataEnv}
                demoUiEnabled={demoUiEnabled}
                onOpenCandidateDetail={openCandidateDetail}
                onOpenHeatmap={() => handleNavigate('heatmap')}
              />
            </div>
            {tabPage === 'projects' && (
              <ProjectPage nickname={nickname} dataEnv={dataEnv} demoUiEnabled={demoUiEnabled} onOpenProjectDetail={openProjectDetail} />
            )}
            {tabPage === 'notifications' && (
              <NotificationsPage dataEnv={dataEnv} nickname={nickname} />
            )}
            {tabPage === 'settings' && (
              <SettingsPage demoUiEnabled={demoUiEnabled} onToggleDemoUi={setDemoUiEnabled} />
            )}
            {tabPage === 'heatmap' && (
              <HeatmapPage dataEnv={dataEnv} onSelectCandidate={openCandidateDetail} />
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
      {/* 詳細を開いている間も一覧側はアンマウントしない。
          以前は詳細のときに renderMain() を丸ごと差し替えていたため、人材マップの
          絞り込み（スキル・期間・選択中の都道府県・ズーム）が戻ると消えていた。 */}
      <div className={detail ? 'hidden' : 'block'}>{renderMain()}</div>
      {detail?.kind === 'candidate' && (
        <Suspense fallback={<div className="flex justify-center items-center p-10 text-gray-400 text-sm">読み込み中...</div>}>
          <CandidateDetailPage
            candidateId={detail.id}
            nickname={nickname}
            dataEnv={dataEnv}
            onBack={() => setDetail(null)}
          />
        </Suspense>
      )}
      {detail?.kind === 'project' && (
        <Suspense fallback={<div className="flex justify-center items-center p-10 text-gray-400 text-sm">読み込み中...</div>}>
          <ProjectDetailPage projectId={detail.id} nickname={nickname} dataEnv={dataEnv} onBack={() => setDetail(null)} />
        </Suspense>
      )}
    </Layout>
  )
}

export default function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster: persistBuster(),
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      <AppInner />
    </PersistQueryClientProvider>
  )
}
