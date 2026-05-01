import { useState } from 'react'
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

const queryClient = new QueryClient()

type DetailView =
  | { kind: 'candidate'; id: string }
  | { kind: 'project'; id: string }

function AppInner() {
  const { nickname, saveNickname, clearNickname } = useNickname()
  const [tabPage, setTabPage] = useState<Page>('matching')
  const [detail, setDetail] = useState<DetailView | null>(null)

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
    switch (tabPage) {
      case 'matching':
        return (
          <MatchingPage
            nickname={nickname}
            onOpenCandidateDetail={openCandidateDetail}
            onOpenProjectDetail={openProjectDetail}
          />
        )
      case 'candidates':
        return <CandidatePage nickname={nickname} onOpenCandidateDetail={openCandidateDetail} />
      case 'projects':
        return <ProjectPage nickname={nickname} onOpenProjectDetail={openProjectDetail} />
    }
  }

  return (
    <Layout
      activeTab={tabPage}
      onNavigate={handleNavigate}
      nickname={nickname}
      onClearNickname={clearNickname}
    >
      {detail?.kind === 'candidate' ? (
        <CandidateDetailPage
          candidateId={detail.id}
          nickname={nickname}
          onBack={() => setDetail(null)}
        />
      ) : detail?.kind === 'project' ? (
        <ProjectDetailPage projectId={detail.id} nickname={nickname} onBack={() => setDetail(null)} />
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
