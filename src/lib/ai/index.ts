// ============================================================
// AI プロバイダーファクトリ
// AI_PROVIDER=gemini（デフォルト）/ openai で切り替え
// ============================================================
import type { AIProvider } from './types'
import { geminiProvider } from './geminiProvider'
import { openaiProvider } from './openaiProvider'

function createAIProvider(): AIProvider {
  const provider = import.meta.env.VITE_AI_PROVIDER ?? 'gemini'
  if (provider === 'openai') return openaiProvider
  return geminiProvider
}

export const ai: AIProvider = createAIProvider()
export type { AIProvider } from './types'
export type {
  AnalyzeCandidateRequest,
  AnalyzeCandidateResponse,
  AnalyzeProjectRequest,
  AnalyzeProjectResponse,
  MatchRequest,
  MatchResponse,
} from './types'
