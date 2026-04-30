import { GoogleGenerativeAI } from '@google/generative-ai'
import type {
  AIProvider,
  AnalyzeCandidateRequest,
  AnalyzeCandidateResponse,
  AnalyzeProjectRequest,
  AnalyzeProjectResponse,
  MatchRequest,
  MatchResponse,
} from './types'

const MODEL = 'gemini-2.0-flash-lite'

function getClient(): GoogleGenerativeAI {
  const key = import.meta.env.VITE_GEMINI_API_KEY as string
  if (!key) throw new Error('VITE_GEMINI_API_KEY が設定されていません')
  return new GoogleGenerativeAI(key)
}

async function generate(prompt: string): Promise<string> {
  const genAI = getClient()
  const model = genAI.getGenerativeModel({ model: MODEL })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

function parseJSON<T>(raw: string): T {
  // コードブロック（```json ... ```）を除去してパース
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned) as T
}

export const geminiProvider: AIProvider = {
  async analyzeCandidate(req: AnalyzeCandidateRequest): Promise<AnalyzeCandidateResponse> {
    const prompt = `
以下のテキストから人材情報を抽出し、JSON形式のみで返してください。
コードブロックや説明文は不要です。

抽出項目:
- name: string（氏名。不明なら "不明"）
- email: string | null
- phone: string | null
- skills: string[]（スキル・資格・言語等。空なら[]）
- experienceYears: number | null（経験年数。不明ならnull）
- summary: string（200字以内の要約）

テキスト:
${req.rawText}

JSON:`.trim()

    const raw = await generate(prompt)
    return parseJSON<AnalyzeCandidateResponse>(raw)
  },

  async analyzeProject(req: AnalyzeProjectRequest): Promise<AnalyzeProjectResponse> {
    const prompt = `
以下のテキストから案件情報を抽出し、JSON形式のみで返してください。
コードブロックや説明文は不要です。

抽出項目:
- title: string（案件名。不明なら "案件"）
- client: string | null（クライアント名）
- description: string（案件概要）
- requiredSkills: string[]（必須スキル・技術。空なら[]）
- budgetMin: number | null（月額最低単価・万円。不明ならnull）
- budgetMax: number | null（月額最高単価・万円。不明ならnull）

テキスト:
${req.rawText}

JSON:`.trim()

    const raw = await generate(prompt)
    return parseJSON<AnalyzeProjectResponse>(raw)
  },

  async matchCandidateToProject(req: MatchRequest): Promise<MatchResponse> {
    const prompt = `
以下の人材と案件のマッチング度を評価し、JSON形式のみで返してください。
コードブロックや説明文は不要です。

人材:
${JSON.stringify(req.candidateProfile, null, 2)}

案件:
${JSON.stringify(req.projectRequirements, null, 2)}

評価項目:
- score: number（0〜100のマッチングスコア）
- summary: string（マッチング理由を200字以内で）
- duplicateSuspected: boolean（人材の名前・スキルが既存候補と非常に似ている場合true）

JSON:`.trim()

    const raw = await generate(prompt)
    return parseJSON<MatchResponse>(raw)
  },
}
