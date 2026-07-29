/**
 * skillYears のキーとスキル名の照合ユーティリティ。
 *
 * 旧実装は双方向の無条件 includes だったため「Java」キーが「JavaScript」表示にも
 * マッチして誤った年数ラベルが付く実害があった（IM 実データ）。
 * 部分一致は単語境界（前後が英数字でないこと）を要求する:
 *   - "sql" ⊂ "sql server" → 境界OK（後続が空白）
 *   - "java" ⊂ "javascript" → 境界NG（後続が英字）
 */

/** 長い方の文字列に短い方が「単語として」含まれるか（英数字境界チェック付き） */
function boundaryIncludes(long: string, short: string): boolean {
  if (short.length < 3) return false
  const idx = long.indexOf(short)
  if (idx === -1) return false
  const before = idx > 0 ? long[idx - 1] : ''
  const after = idx + short.length < long.length ? long[idx + short.length] : ''
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)
}

/**
 * skillYears からスキル名に対応する経験月数を探す。
 * 完全一致（空白無視）を最優先し、次に単語境界付き部分一致を試す。
 */
export function findSkillMonths(
  skillYears: Record<string, number> | null | undefined,
  skill: string,
): number | null {
  if (!skillYears) return null
  const lowerNoSpace = skill.toLowerCase().replace(/\s/g, '')
  // 1. 完全一致（空白無視）
  for (const [k, v] of Object.entries(skillYears)) {
    if (k.startsWith('_')) continue
    if (k.toLowerCase().replace(/\s/g, '') === lowerNoSpace) return v
  }
  // 2. 単語境界付き部分一致（空白は保持して境界判定に使う）
  const lower = skill.toLowerCase().trim()
  for (const [k, v] of Object.entries(skillYears)) {
    if (k.startsWith('_')) continue
    const kl = k.toLowerCase().trim()
    if (boundaryIncludes(kl, lower) || boundaryIncludes(lower, kl)) return v
  }
  return null
}
