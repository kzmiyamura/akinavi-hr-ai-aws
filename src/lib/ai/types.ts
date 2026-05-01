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
  /** 尚可・歓迎スキル（あれば。DBカラムは raw_data にも残す） */
  niceToHaveSkills?: string[]
  budgetMin: number | null
  budgetMax: number | null
  /** 開始予定日 YYYY-MM-DD（不明なら null） */
  startDate?: string | null
  /** 終了予定日 YYYY-MM-DD（不明なら null） */
  endDate?: string | null
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
