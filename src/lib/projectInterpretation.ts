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

/**
 * 「この案件は特定の技術圏に広く精通した人を求めている」というAIの読み。
 * 必須スキルの単語一致では表せない要求（Azure・M365・PowerShell・EntraID が並ぶ案件は
 * Microsoft スペシャリスト案件）を扱うために持つ。
 */
export interface AiSpecialist {
  /** 技術圏の名前（Microsoft / AWS / Salesforce 等） */
  ecosystem: string
  /** その圏での精通を裏付ける技術名（skill_master にあるものだけ） */
  coreSkills: string[]
  reason?: string | null
}

export interface AiInterpretation {
  at?: string
  model?: string | null
  confidence?: string | null
  multiPerson?: boolean
  evidence?: string | null
  relatedSkills?: AiRelatedSkill[]
  specialist?: AiSpecialist | null
  /** どんな人を求めている案件かの所見（営業が読む用） */
  summary?: string | null
  /** 本文なし・複数案件メール由来などで解釈できなかったときの理由 */
  skipped?: string
}

export function getAiInterpretation(rawData: unknown): AiInterpretation | null {
  const ai = (rawData as { aiInterpretation?: unknown } | null | undefined)?.aiInterpretation
  if (!ai || typeof ai !== 'object') return null
  return ai as AiInterpretation
}

/**
 * 候補者がその技術圏をどれだけ押さえているか。
 *
 * 判定は必須スキルの緑バッジと同じ matcher（サーバの skill_satisfies と同じ結果）に
 * 委ねる。ここで別の一致ルールを作ると、また判定が増えて食い違う。
 */
export function ecosystemCoverage(
  spec: AiSpecialist | null | undefined,
  candidateSkills: string[],
  matcher: (candidateSkill: string, requiredSkill: string) => boolean,
): { hit: string[]; total: number; ratio: number } | null {
  const core = spec?.coreSkills ?? []
  if (core.length === 0) return null
  const hit = core.filter((c) => candidateSkills.some((sk) => matcher(sk, c)))
  return { hit, total: core.length, ratio: hit.length / core.length }
}

/** AIが尚可に足したスキル名の照合用セット（小文字・trim）。reason 引きにも使う */
export function aiRelatedSkillMap(rawData: unknown): Map<string, string | null> {
  const m = new Map<string, string | null>()
  for (const s of getAiInterpretation(rawData)?.relatedSkills ?? []) {
    if (typeof s?.name === 'string' && s.name.trim()) m.set(s.name.trim().toLowerCase(), s.reason ?? null)
  }
  return m
}
