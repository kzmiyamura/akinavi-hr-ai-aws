// ============================================================
// OpenAI プロバイダー（切替用スタブ）
// AI_PROVIDER=openai かつ OPENAI_API_KEY 設定時に使用
// ============================================================
import type {
  AIProvider,
  AnalyzeCandidateRequest,
  AnalyzeCandidateResponse,
  AnalyzeProjectRequest,
  AnalyzeProjectResponse,
  MatchRequest,
  MatchResponse,
} from './types'

// OpenAI SDK は将来インストール: npm install openai
// import OpenAI from 'openai'

export const openaiProvider: AIProvider = {
  async analyzeCandidate(_req: AnalyzeCandidateRequest): Promise<AnalyzeCandidateResponse> {
    throw new Error('OpenAI プロバイダーは未実装です。OPENAI_API_KEY を設定し実装してください。')
  },
  async analyzeProject(_req: AnalyzeProjectRequest): Promise<AnalyzeProjectResponse> {
    throw new Error('OpenAI プロバイダーは未実装です。')
  },
  async matchCandidateToProject(_req: MatchRequest): Promise<MatchResponse> {
    throw new Error('OpenAI プロバイダーは未実装です。')
  },
}
