import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNickname } from './hooks/useNickname'
import { NicknameModal } from './components/NicknameModal'
import { Layout } from './components/Layout'
import type { Page } from './components/Layout'
import { CandidatePage } from './pages/CandidatePage'
import { ProjectPage } from './pages/ProjectPage'
import { MatchingPage } from './pages/MatchingPage'
import { HistoryPage } from './pages/HistoryPage'
import { DuplicatePage } from './pages/DuplicatePage'
import { MonitorPage } from './pages/MonitorPage'

const queryClient = new QueryClient()

function AppInner() {
  const { nickname, saveNickname, clearNickname } = useNickname()
  const [currentPage, setCurrentPage] = useState<Page>('candidates')

  if (!nickname) {
    return <NicknameModal onSave={saveNickname} />
  }

  const renderPage = () => {
    switch (currentPage) {
      case 'candidates': return <CandidatePage nickname={nickname} />
      case 'projects':   return <ProjectPage nickname={nickname} />
      case 'matching':   return <MatchingPage nickname={nickname} />
      case 'history':    return <HistoryPage />
      case 'duplicates': return <DuplicatePage />
      case 'monitor':    return <MonitorPage />
    }
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      nickname={nickname}
      onClearNickname={clearNickname}
    >
      {renderPage()}
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
