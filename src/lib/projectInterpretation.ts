// 案件条件のAI解釈（raw_data.aiInterpretation）の読み取りヘルパー。
//
// 書き込みはワーカー（scripts/llm_extract/shadow_worker.mjs の projectInterpretCycle →
// buildInterpretationPatch）だけが行う。AIが足した関連スキルは raw_data.niceToHaveSkills に
// 統合済みなので、スコア計算側はこのファイルを知らなくてよい。
// ここは「どれをAIが足したか」を画面でバッジ表示するためだけに使う。

export interface AiRelatedSkill {
  name: string
  reason?: string | null
}

export interface AiInterpretation {
  at?: string
  model?: string | null
  confidence?: string | null
  multiPerson?: boolean
  evidence?: string | null
  relatedSkills?: AiRelatedSkill[]
  /** 本文なし・複数案件メール由来などで解釈できなかったときの理由 */
  skipped?: string
}

export function getAiInterpretation(rawData: unknown): AiInterpretation | null {
  const ai = (rawData as { aiInterpretation?: unknown } | null | undefined)?.aiInterpretation
  if (!ai || typeof ai !== 'object') return null
  return ai as AiInterpretation
}

/** AIが尚可に足したスキル名の照合用セット（小文字・trim）。reason 引きにも使う */
export function aiRelatedSkillMap(rawData: unknown): Map<string, string | null> {
  const m = new Map<string, string | null>()
  for (const s of getAiInterpretation(rawData)?.relatedSkills ?? []) {
    if (typeof s?.name === 'string' && s.name.trim()) m.set(s.name.trim().toLowerCase(), s.reason ?? null)
  }
  return m
}
