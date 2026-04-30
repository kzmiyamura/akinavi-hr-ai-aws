// ============================================================
// AI プロバイダー共通インターフェース
// ============================================================

/** 人材プロフィール解析のリクエスト */
export interface AnalyzeCandidateRequest {
  rawText: string // メール本文や自由記述テキスト
}

/** 人材プロフィール解析のレスポンス */
export interface AnalyzeCandidateResponse {
  name: string
  email: string | null
  phone: string | null
  skills: string[]
  experienceYears: number | null
  summary: string
}

/** 案件情報解析のリクエスト */
export interface AnalyzeProjectRequest {
  rawText: string
}

/** 案件情報解析のレスポンス */
export interface AnalyzeProjectResponse {
  title: string
  client: string | null
  description: string
  requiredSkills: string[]
  budgetMin: number | null
  budgetMax: number | null
}

/** マッチングスコアリングのリクエスト */
export interface MatchRequest {
  candidateProfile: AnalyzeCandidateResponse
  projectRequirements: AnalyzeProjectResponse
}

/** マッチングスコアリングのレスポンス */
export interface MatchResponse {
  score: number       // 0〜100
  summary: string     // マッチング理由
  duplicateSuspected: boolean // 他候補との類似疑い
}

/** AIプロバイダー共通インターフェース */
export interface AIProvider {
  analyzeCandidate(req: AnalyzeCandidateRequest): Promise<AnalyzeCandidateResponse>
  analyzeProject(req: AnalyzeProjectRequest): Promise<AnalyzeProjectResponse>
  matchCandidateToProject(req: MatchRequest): Promise<MatchResponse>
}
