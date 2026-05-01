import { GoogleGenerativeAI } from '@google/generative-ai'
import {
  type AIProvider,
  type AnalyzeCandidateRequest,
  type AnalyzeCandidateResponse,
  type AnalyzeProjectRequest,
  type AnalyzeProjectResponse,
  type CandidateSkillsByCategory,
  type MatchRequest,
  type MatchResponse,
  emptySkillsByCategory,
  normalizeCandidateSkillsByCategory,
  skillsByCategoryHasAny,
} from './types'

/** v1beta で generateContent 可能なモデル（旧 gemini-1.5-flash-8b は 404 になる） */
function resolveModel(): string {
  const fromEnv = (import.meta.env.VITE_GEMINI_MODEL as string | undefined)?.trim()
  if (fromEnv) return fromEnv
  return 'gemini-2.0-flash'
}

function getClient(): GoogleGenerativeAI {
  const key = import.meta.env.VITE_GEMINI_API_KEY as string
  if (!key) throw new Error('VITE_GEMINI_API_KEY が設定されていません')
  return new GoogleGenerativeAI(key)
}

async function generate(prompt: string): Promise<string> {
  const genAI = getClient()
  const model = genAI.getGenerativeModel({ model: resolveModel() })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

function parseJSON<T>(raw: string): T {
  // コードブロック（```json ... ```）を除去してパース
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned) as T
}

/** 第1パスで skillsByCategory が空のとき、skills 一覧だけ再分類（ブラウザ登録の取りこぼし対策） */
async function categorizeSkillsOnly(skills: string[], contextText: string): Promise<CandidateSkillsByCategory> {
  const unique = [
    ...new Map(
      skills
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => [s.toLowerCase(), s]),
    ).values(),
  ]
  if (unique.length === 0) return emptySkillsByCategory()

  const prompt = `
あなたはスキル分類器です。次の skills の各要素を、次の14キーのうちちょうど1つにだけ割り当ててください。
- skills にある文字列を**表記そのまま**使う（略称・別名に変えない）。
- 各スキル語は**1つのキーにだけ**入れる（重複禁止）。
- どのキーにも合わない語は others に。
- JSONのみ。コードブロック禁止。

キー（この14個のみ）:
languages, frameworks, libraries, os, databases, dwh, clouds, infrastructures, tools, methodologies, certifications, design, marketing, others

skills:
${JSON.stringify(unique)}

参考（文脈）:
${contextText.slice(0, 3500)}

JSON:
`.trim()

  const raw = await generate(prompt)
  return normalizeCandidateSkillsByCategory(parseJSON<Partial<CandidateSkillsByCategory>>(raw))
}

export const geminiProvider: AIProvider = {
  async analyzeCandidate(req: AnalyzeCandidateRequest): Promise<AnalyzeCandidateResponse> {
    const prompt = `
以下のテキストから人材情報を抽出し、JSON形式のみで返してください。
コードブロックや説明文は不要です。

【スキル】
- 「/」「・」「,」「、」区切りは必ず個別要素に分割（例: "PHP / WordPress" → 別要素）。
- skills は重複なしのフラット配列（全カテゴリに入った語を漏れなく含める）。
- skillsByCategory は次の14キーのみ（追加禁止）。該当なしは []。どれにも当てはまらない語は必ず others に。
  - languages: プログラミング・クエリ言語（PHP, JavaScript, Perl, SQL, HTML, CSS 等）
  - frameworks: Web FW・アプリFW（CodeIgniter, FuelPHP 等）
  - libraries: jQuery 等のライブラリ
  - os: Linux, Windows 等
  - databases: MySQL, FileMaker（DB用途）等
  - dwh: DWH・BI 製品
  - clouds: AWS, GCP 等
  - infrastructures: VPN, Webサーバ, ネットワーク運用, Docker 等インフラ寄り
  - tools: Git, Excel, WordPress（CMSツール運用）, Office, FileMaker（業務ツール）等
  - methodologies: 要件定義, ディレクション, PM, アジャイル 等
  - certifications: 資格・検定（ドットコムマスター等）
  - design: デザイン・クリエイティブ（該当時のみ）
  - marketing: マーケ・集客
  - others: 上記以外（技術翻訳, 技術書執筆, アクセシビリティ対応 等もここで可）

【その他フィールド】
- roles: 経験職種・役割の配列
- industries: 経験業界の配列
- nearestStation: 最寄駅（都道府県＋駅名が分かればその形式）
- prefecture, availableRegions, currentWorkLocation, remoteAvailable: 本文から判読できる範囲で

抽出項目:
- name, email, phone, skills, skillsByCategory, roles, industries
- experienceYears, summary（300字以内・強み・職種を具体的に）
- nearestStation, prefecture, availableRegions, currentWorkLocation, remoteAvailable

テキスト:
${req.rawText}

JSON:`.trim()

    const raw = await generate(prompt)
    const data = parseJSON<AnalyzeCandidateResponse>(raw)

    const normalizedSbc =
      data.skillsByCategory != null
        ? normalizeCandidateSkillsByCategory(data.skillsByCategory)
        : emptySkillsByCategory()
    data.skillsByCategory = normalizedSbc

    if (!skillsByCategoryHasAny(normalizedSbc) && (data.skills?.length ?? 0) > 0) {
      try {
        const repaired = await categorizeSkillsOnly(data.skills!, req.rawText)
        if (skillsByCategoryHasAny(repaired)) {
          data.skillsByCategory = repaired
        }
      } catch {
        /* フォールバック失敗時は skills のみ */
      }
    }

    if (
      (!data.skills || data.skills.length === 0)
      && data.skillsByCategory
      && skillsByCategoryHasAny(data.skillsByCategory)
    ) {
      const flat = Object.values(data.skillsByCategory).flat()
      data.skills = [...new Map(flat.map((s) => [s.toLowerCase(), s])).values()]
    }
    return data
  },

  async analyzeProject(req: AnalyzeProjectRequest): Promise<AnalyzeProjectResponse> {
    const prompt = `
以下のテキストから案件情報を抽出し、JSON形式のみで返してください。
コードブロックや説明文は不要です。

【ルール】
- 書かれていない情報は推測せず null または空配列にしてください。
- requiredSkills は「必須・必須スキル」に該当するもののみ。尚可・歓迎は niceToHaveSkills に入れてください。
- 「A / B / C」のスキル列は個別要素に分割してください。
- budgetMin/budgetMax は月額の万円単位の数値のみ（「60万」→ 60）。レンジが1値だけなら min=max にしてよいです。
- startDate / endDate は YYYY-MM-DD 形式のみ。本文に日付がなければ null。
- headcount は募集人数の整数のみ。「2名」→ 2。複数レンジで不明なら null。
- settlementMin / settlementMax は本文に明記された精算の下限・上限を時間で表せる数値のみ（例: 7, 8、月次精算 140-180 なら 140 と 180）。曖昧なら null。
- workLocation / remotePolicy / contractType / workload / roleSummary / industry は本文の表現を短く要約。なければ null。

抽出項目:
- title: string（案件名。件名・本文から。不明なら "案件"）
- client: string | null（クライアント名・エンド名。不明なら null）
- description: string（案件概要・作業内容。箇条書き可）
- requiredSkills: string[]（必須スキル・技術。空なら[]）
- niceToHaveSkills: string[]（尚可・歓迎。なければ[]）
- budgetMin: number | null（月額最低単価・万円。不明ならnull）
- budgetMax: number | null（月額最高単価・万円。不明ならnull）
- startDate: string | null（開始予定 YYYY-MM-DD）
- endDate: string | null（終了予定 YYYY-MM-DD）
- workLocation: string | null（勤務地・オフィス・エリア）
- remotePolicy: string | null（リモート可否・出社頻度の要約）
- contractType: string | null（業務委託・派遣・準委任等）
- headcount: number | null（募集人数）
- workload: string | null（稼働日数・週稼働の目安）
- settlementMin: number | null
- settlementMax: number | null
- roleSummary: string | null（PL/SE/PG 等の役割）
- industry: string | null（業界）

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
- score: number（0〜100のマッチングスコア。スキル適合に加え、案件の勤務地・リモート方針・契約形態・役割・業界と人材の希望・経験の整合も加味すること）
- summary: string（マッチング理由を200字以内で）
- duplicateSuspected: boolean（人材の名前・スキルが既存候補と非常に似ている場合true）

JSON:`.trim()

    const raw = await generate(prompt)
    return parseJSON<MatchResponse>(raw)
  },
}
