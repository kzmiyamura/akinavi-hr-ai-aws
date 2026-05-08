import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNickname } from './hooks/useNickname'
import { NicknameModal } from './components/NicknameModal'
import { Layout } from './components/Layout'
import type { Page } from './components/Layout'
import { CandidatePage } from './pages/CandidatePage'
import { ProjectPage } from './pages/ProjectPage'
import { MatchingPage } from './pages/MatchingPage'
import { CandidateDetailPage } from './pages/CandidateDetailPage'
import { ProjectDetailPage } from './pages/ProjectDetailPage'
import { SettingsPage } from './pages/SettingsPage'
import type { DataEnv } from './lib/dataEnv'
import {
  applyDemoKeyFromUrlToggle,
  getDemoUiEnabled,
  readStoredDataEnv,
  writeStoredDataEnv,
} from './lib/dataEnv'

const queryClient = new QueryClient()

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
        <div className={tabPage === 'candidates' ? 'block' : 'hidden'}>
          <CandidatePage
            nickname={nickname}
            dataEnv={dataEnv}
            demoUiEnabled={demoUiEnabled}
            onOpenCandidateDetail={openCandidateDetail}
          />
        </div>
        <div className={tabPage === 'projects' ? 'block' : 'hidden'}>
          <ProjectPage nickname={nickname} dataEnv={dataEnv} demoUiEnabled={demoUiEnabled} onOpenProjectDetail={openProjectDetail} />
        </div>
        <div className={tabPage === 'settings' ? 'block' : 'hidden'}>
          <SettingsPage />
        </div>
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
        <CandidateDetailPage
          candidateId={detail.id}
          nickname={nickname}
          dataEnv={dataEnv}
          onBack={() => setDetail(null)}
        />
      ) : detail?.kind === 'project' ? (
        <ProjectDetailPage projectId={detail.id} nickname={nickname} dataEnv={dataEnv} onBack={() => setDetail(null)} />
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
