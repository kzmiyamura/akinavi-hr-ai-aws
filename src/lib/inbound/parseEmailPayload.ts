// Edge Function と共有するメール解析ロジック（Vitest でテスト可能な純粋関数）

export interface EmailPayload {
  from: string
  subject: string
  text?: string
  html?: string
}

export interface ParsedEmail {
  from: string
  subject: string
  body: string
}

export interface AnalyzedCandidate {
  name: string
  email: string | null
  phone: string | null
  skills: string[]
  experienceYears: number | null
  summary: string
}

/** Resend Webhook ペイロードからメール本文を抽出する */
export function extractEmailBody(payload: EmailPayload): ParsedEmail | null {
  const body = payload.text ?? payload.html ?? ''
  if (!body.trim()) return null
  return {
    from: payload.from ?? '',
    subject: payload.subject ?? '',
    body,
  }
}

/** AI レスポンスのコードブロックを除去して JSON パースする */
export function parseAIResponse(raw: string): AnalyzedCandidate {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned) as AnalyzedCandidate
}

/** 差出人フィールド（"山田 太郎 <yamada@example.com>" 形式）からメールアドレスを抽出する */
export function extractEmailFromFrom(from: string): string | null {
  const match = from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)
  return match ? match[0] : null
}

/** 添付ファイル名から氏名を推測する */
export function extractNameFromFilename(filename: string): string | null {
  if (!filename) return null
  // 拡張子を除去
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '')
  // アンダースコアやハイフンで分割し、最後の部分を氏名候補とする
  const parts = nameWithoutExt.split(/[_-]/)
  const lastPart = parts[parts.length - 1]
  // 日本語の姓名パターン（2-4文字の漢字ひらがなカタカナ）にマッチするかチェック
  if (/^[ぁ-んァ-ン一-龯]{2,4}$/.test(lastPart)) {
    return lastPart
  }
  // アルファベット+数字のパターン（例: OH_一之江 → 一之江）
  const match = nameWithoutExt.match(/[a-zA-Z_]+([ぁ-んァ-ン一-龯]{2,4})/)
  if (match) return match[1]
  return null
}

/** AI 解析結果と差出人情報から DB 保存用ペイロードを構築する */
export function buildCandidatePayload(
  analyzed: AnalyzedCandidate,
  parsed: ParsedEmail,
  createdBy = 'resend-inbound',
) {
  const email = analyzed.email || extractEmailFromFrom(parsed.from)
  return {
    name: analyzed.name ?? '不明',
    email,
    phone: analyzed.phone ?? null,
    skills: analyzed.skills ?? [],
    experience_years: analyzed.experienceYears ?? null,
    raw_profile: {
      text: parsed.body.slice(0, 5000),
      summary: analyzed.summary ?? '',
      from: parsed.from,
      subject: parsed.subject,
    },
    duplicate_flag: false,
    created_by: createdBy,
  }
}
