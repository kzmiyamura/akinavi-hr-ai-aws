import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  AnalyzeCandidateResponse,
  AnalyzeProjectResponse,
  CandidateSkillsByCategory,
  MatchResponse,
} from '../types'

function sbc(partial: Partial<CandidateSkillsByCategory>): CandidateSkillsByCategory {
  return {
    languages: partial.languages ?? [],
    frameworks: partial.frameworks ?? [],
    libraries: partial.libraries ?? [],
    os: partial.os ?? [],
    databases: partial.databases ?? [],
    dwh: partial.dwh ?? [],
    clouds: partial.clouds ?? [],
    infrastructures: partial.infrastructures ?? [],
    tools: partial.tools ?? [],
    methodologies: partial.methodologies ?? [],
    certifications: partial.certifications ?? [],
    design: partial.design ?? [],
    marketing: partial.marketing ?? [],
    others: partial.others ?? [],
  }
}

// generateContent のモック関数（テストごとに差し替え）
const mockGenerateContent = vi.fn()

// Gemini SDK をクラスとしてモック
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: mockGenerateContent }
    }
  },
}))

vi.stubEnv('VITE_GEMINI_API_KEY', 'test-api-key')

// ─── ヘルパー ──────────────────────────────────────────────

function makeTextResponse(obj: unknown) {
  return { response: { text: () => JSON.stringify(obj) } }
}

function makeCodeBlockResponse(obj: unknown) {
  return { response: { text: () => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`` } }
}

// ─── テスト ────────────────────────────────────────────────

describe('GeminiProvider', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset()
    vi.resetModules()
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-api-key')
    vi.stubEnv('VITE_AI_PROVIDER', 'gemini')
  })

  // analyzeCandidate ─────────────────────────────────────────

  it('analyzeCandidate: テキストから人材情報を正しく抽出する', async () => {
    const expected: AnalyzeCandidateResponse = {
      name: '山田 太郎',
      email: 'yamada@example.com',
      phone: '090-1234-5678',
      skills: ['Java', 'Spring Boot', 'AWS'],
      experienceYears: 5,
      summary: 'Java 5年のバックエンドエンジニア',
      skillsByCategory: sbc({
        languages: ['Java'],
        frameworks: ['Spring Boot'],
        clouds: ['AWS'],
      }),
    }
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.analyzeCandidate({
      rawText: '山田太郎です。Java 5年、AWS経験あり。yamada@example.com',
    })

    expect(result.name).toBe('山田 太郎')
    expect(result.email).toBe('yamada@example.com')
    expect(result.skills).toContain('Java')
    expect(result.experienceYears).toBe(5)
  })

  it('analyzeCandidate: コードブロック付きレスポンスも正しくパースする', async () => {
    const expected: AnalyzeCandidateResponse = {
      name: '佐藤 花子',
      email: null,
      phone: null,
      skills: ['React', 'TypeScript'],
      experienceYears: 3,
      summary: 'フロントエンドエンジニア',
      skillsByCategory: sbc({ languages: ['React', 'TypeScript'] }),
    }
    mockGenerateContent.mockResolvedValueOnce(makeCodeBlockResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.analyzeCandidate({ rawText: '佐藤花子、React 3年' })

    expect(result.name).toBe('佐藤 花子')
    expect(result.skills).toContain('TypeScript')
  })

  it('analyzeCandidate: email が null の場合も正しく扱う', async () => {
    const expected: AnalyzeCandidateResponse = {
      name: '不明',
      email: null,
      phone: null,
      skills: [],
      experienceYears: null,
      summary: '情報なし',
    }
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.analyzeCandidate({ rawText: '詳細不明' })

    expect(result.email).toBeNull()
    expect(result.skills).toHaveLength(0)
  })

  it('analyzeCandidate: skills だけ返し skillsByCategory が空のとき第2パスで補完する', async () => {
    const first: AnalyzeCandidateResponse = {
      name: '補完テスト',
      email: null,
      phone: null,
      skills: ['PHP', 'MySQL'],
      experienceYears: 2,
      summary: 'テスト',
    }
    const second = sbc({
      languages: ['PHP'],
      databases: ['MySQL'],
    })
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(first))
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(second))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.analyzeCandidate({ rawText: 'PHPとMySQL' })

    expect(mockGenerateContent).toHaveBeenCalledTimes(2)
    expect(result.skillsByCategory?.languages).toContain('PHP')
    expect(result.skillsByCategory?.databases).toContain('MySQL')
  })

  // analyzeProject ───────────────────────────────────────────

  it('analyzeProject: テキストから案件情報を正しく抽出する', async () => {
    const expected: AnalyzeProjectResponse = {
      title: 'ECサイト開発',
      client: '株式会社ABC',
      description: 'ECサイトのバックエンド開発',
      requiredSkills: ['Java', 'PostgreSQL'],
      budgetMin: 60,
      budgetMax: 80,
    }
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.analyzeProject({
      rawText: 'ECサイト開発案件。Java必須。単価60〜80万。ABC社。',
    })

    expect(result.title).toBe('ECサイト開発')
    expect(result.requiredSkills).toContain('Java')
    expect(result.budgetMin).toBe(60)
    expect(result.budgetMax).toBe(80)
  })

  it('analyzeProject: 単価不明の場合 null を返す', async () => {
    const expected: AnalyzeProjectResponse = {
      title: '開発案件',
      client: null,
      description: '詳細未定',
      requiredSkills: ['Python'],
      budgetMin: null,
      budgetMax: null,
    }
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.analyzeProject({ rawText: '単価未定のPython案件' })

    expect(result.budgetMin).toBeNull()
    expect(result.budgetMax).toBeNull()
  })

  // matchCandidateToProject ──────────────────────────────────

  it('matchCandidateToProject: スコアとサマリーを返す', async () => {
    const expected: MatchResponse = {
      score: 85,
      summary: 'Java・AWS のスキルが案件要件と高度に一致しています。',
      duplicateSuspected: false,
    }
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.matchCandidateToProject({
      candidateProfile: {
        name: '山田 太郎', email: 'yamada@example.com', phone: null,
        skills: ['Java', 'AWS'], experienceYears: 5, summary: 'バックエンドエンジニア',
      },
      projectRequirements: {
        title: 'ECサイト開発', client: null, description: 'バックエンド開発',
        requiredSkills: ['Java', 'PostgreSQL'], budgetMin: 60, budgetMax: 80,
      },
    })

    expect(result.score).toBe(85)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.duplicateSuspected).toBe(false)
  })

  it('matchCandidateToProject: 類似候補がいる場合 duplicateSuspected=true を返す', async () => {
    const expected: MatchResponse = {
      score: 70,
      summary: '要件に一致するが既存候補と類似。',
      duplicateSuspected: true,
    }
    mockGenerateContent.mockResolvedValueOnce(makeTextResponse(expected))

    const { geminiProvider } = await import('../geminiProvider')
    const result = await geminiProvider.matchCandidateToProject({
      candidateProfile: {
        name: '山田 T', email: null, phone: null,
        skills: ['Java'], experienceYears: 5, summary: '',
      },
      projectRequirements: {
        title: '案件', client: null, description: '',
        requiredSkills: ['Java'], budgetMin: null, budgetMax: null,
      },
    })

    expect(result.duplicateSuspected).toBe(true)
  })

  // プロバイダー切り替え ──────────────────────────────────────

  it('VITE_AI_PROVIDER=gemini のとき ai オブジェクトが定義される', async () => {
    vi.stubEnv('VITE_AI_PROVIDER', 'gemini')
    const { ai } = await import('../index')
    expect(ai).toBeDefined()
    expect(typeof ai.analyzeCandidate).toBe('function')
  })

  it('VITE_AI_PROVIDER=openai のとき未実装エラーをスローする', async () => {
    vi.stubEnv('VITE_AI_PROVIDER', 'openai')
    const { ai } = await import('../index')
    await expect(ai.analyzeCandidate({ rawText: 'test' })).rejects.toThrow('未実装')
  })
})
