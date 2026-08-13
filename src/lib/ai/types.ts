// ============================================================
// AI プロバイダー共通インターフェース
// ============================================================

/** Gemini multimodal に渡す画像データ */
export interface ImageFileData {
  mimeType: string
  data: string // base64
}

/** 人材プロフィール解析のリクエスト */
export interface AnalyzeCandidateRequest {
  rawText: string // メール本文や自由記述テキスト
  imageFiles?: ImageFileData[] // 画像ファイル（スキャンPDF・写真等）
}

/** 人材スキル14カテゴリ（`candidate_skills` CHECK・Edge `inbound-email` と同一キー） */
export interface CandidateSkillsByCategory {
  languages: string[]
  frameworks: string[]
  libraries: string[]
  os: string[]
  databases: string[]
  dwh: string[]
  clouds: string[]
  infrastructures: string[]
  tools: string[]
  methodologies: string[]
  certifications: string[]
  design: string[]
  marketing: string[]
  others: string[]
}

export function emptySkillsByCategory(): CandidateSkillsByCategory {
  return {
    languages: [],
    frameworks: [],
    libraries: [],
    os: [],
    databases: [],
    dwh: [],
    clouds: [],
    infrastructures: [],
    tools: [],
    methodologies: [],
    certifications: [],
    design: [],
    marketing: [],
    others: [],
  }
}

/** AI の部分キー・不正型を14カテゴリに正規化 */
export function normalizeCandidateSkillsByCategory(
  input: Partial<CandidateSkillsByCategory> | undefined | null,
): CandidateSkillsByCategory {
  const e = emptySkillsByCategory()
  if (!input || typeof input !== 'object') return e
  for (const k of Object.keys(e) as (keyof CandidateSkillsByCategory)[]) {
    const arr = input[k]
    e[k] = Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : []
  }
  return e
}

export function skillsByCategoryHasAny(sbc: CandidateSkillsByCategory): boolean {
  return Object.values(sbc).some((arr) => arr.length > 0)
}

/** 人材プロフィール解析のレスポンス */
export interface AnalyzeCandidateResponse {
  name: string
  email: string | null
  phone: string | null
  /** 抽出スキル一覧（重複なし・検索・マッチング用）。skillsByCategory の要素と整合させること */
  skills: string[]
  experienceYears: number | null
  summary: string
  /** スキルを14カテゴリに分類（画面の色分け表示に使用）。無い場合は skills のみ青タグ表示 */
  skillsByCategory?: CandidateSkillsByCategory
  roles?: string[]
  industries?: string[]
  nearestStation?: string | null
  prefecture?: string | null
  availableRegions?: string[] | null
  currentWorkLocation?: string | null
  remoteAvailable?: boolean
  /** 希望単価（例: "55万", "60万円"）— マッチングスコア計算に使用 */
  desiredRate?: string | null
  /** 国籍（例: "中国籍", "日本"）- マッチングの懸念点判断に使用 */
  nationality?: string | null
  /** 自己PR・アピールポイント - AIコメントの定性評価に使用 */
  selfPR?: string | null
}

/** 案件情報解析のリクエスト */
export interface AnalyzeProjectRequest {
  rawText: string
  imageFiles?: ImageFileData[]
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
  /** 勤務地・オフィス・エリア（例: 田町、大阪） */
  workLocation?: string | null
  /** 正規化済みの都道府県（projects.work_prefecture）。勤務地スコアはこちらを優先する */
  workPrefecture?: string | null
  /** 必須スキルごとの重み（projects.skill_weights）。順位付けと同じ配点にするために渡す */
  skillWeights?: Record<string, number> | null
  /** 案件が明示する必要経験年数（projects.required_experience_years） */
  requiredExpYears?: number | null
  /** リモート・出社の要約（例: フルリモート可、週2出社、常駐） */
  remotePolicy?: string | null
  /** 契約形態（例: 業務委託、派遣、準委任） */
  contractType?: string | null
  /** 募集人数（不明なら null） */
  headcount?: number | null
  /** 稼働イメージ（例: 週5日、月20日） */
  workload?: string | null
  /** 精算下限（時間・1日あたり等、数値のみ。不明なら null） */
  settlementMin?: number | null
  /** 精算上限（時間） */
  settlementMax?: number | null
  /** 募集役割（例: PL、SE、インフラエンジニア） */
  roleSummary?: string | null
  /** 業界・ドメイン */
  industry?: string | null
  /** 英語要件: 'none' = 不要 / 'business' = ビジネスレベル以上 / 'native' = ネイティブレベル */
  requiresEnglish?: 'none' | 'business' | 'native'
  /** 受け入れ雇用形態（null/空配列 = 制限なし） 例: ['正社員', '派遣社員'] */
  allowedEmploymentTypes?: string[] | null
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
  ruleScore?: number  // ルールベーススコア（AIスコアとの比較用）
}

/** AIプロバイダー共通インターフェース */
export interface AIProvider {
  analyzeCandidate(req: AnalyzeCandidateRequest): Promise<AnalyzeCandidateResponse>
  analyzeProject(req: AnalyzeProjectRequest): Promise<AnalyzeProjectResponse>
  matchCandidateToProject(req: MatchRequest): Promise<MatchResponse>
}
