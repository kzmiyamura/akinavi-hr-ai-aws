/**
 * 案件の必須スキルごとの重み（projects.skill_weights）。
 *
 * **式の正は `supabase/functions/inbound-email/index.ts` の buildSkillWeights**。
 * ここはその写しで、`src/lib/__tests__/skillWeightsParity.test.ts` が
 * index.ts から関数を切り出して両者の出力を突き合わせている（乖離したらテストが落ちる）。
 * 配点を触るときは必ず両方を直すこと（CLAUDE.md「マッチングの配点は3か所」）。
 *
 * 写しを置く理由: 画面で必須スキルを編集したときに重みを組み直す必要があるのに、
 * フロントに skill_weights を書く経路が1つも無かった（#185）。
 * その結果「求める人」を直しても重みは登録時のまま残り、採点に食い違いが出ていた。
 */

/** カテゴリごとの基礎点。言語が最も重く、工程語（基本設計・テスト等）は最も軽い */
export const SKILL_CATEGORY_WEIGHT: Record<string, number> = {
  languages: 4,
  frameworks: 3,
  databases: 3,
  clouds: 3,
  infrastructures: 3,
  dwh: 3,
  libraries: 2,
  os: 2,
  tools: 2,
  design: 2,
  marketing: 2,
  certifications: 1,
  methodologies: 1,
  others: 1,
}
export const SKILL_WEIGHT_MAX = 6

/**
 * 加点の根拠:
 *   - カテゴリ（言語=4 … 工程語=1）
 *   - 年数指定あり（「Javaでの開発経験（10年程度）」）= +2。年数を書くほど重視されている
 *   - 記載順の先頭 = +1。募集要件は重要なものから書かれる
 */
export function buildSkillWeights(
  requiredSkills: string[],
  categoryOf: (skill: string) => string | null,
  requiredSkillYears: Record<string, number[]>,
): Record<string, number> {
  const out: Record<string, number> = {}
  requiredSkills.forEach((skill, i) => {
    const base = SKILL_CATEGORY_WEIGHT[categoryOf(skill) ?? 'others'] ?? 1
    const yearBonus = (requiredSkillYears[skill]?.length ?? 0) > 0 ? 2 : 0
    const orderBonus = i === 0 ? 1 : 0
    out[skill] = Math.min(base + yearBonus + orderBonus, SKILL_WEIGHT_MAX)
  })
  return out
}
