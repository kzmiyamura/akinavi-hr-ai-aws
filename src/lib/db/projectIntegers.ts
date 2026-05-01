/** projects の integer カラム向け：小数は切り捨て、範囲外は null */
export function normalizeOptionalInt(value: unknown, min: number, max: number): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return null
  const x = Math.trunc(n)
  if (x < min || x > max) return null
  return x
}

export function normalizeProjectIntegerColumns(input: {
  budget_min: number | null
  budget_max: number | null
  headcount: number | null
  settlement_min: number | null
  settlement_max: number | null
}): {
  budget_min: number | null
  budget_max: number | null
  headcount: number | null
  settlement_min: number | null
  settlement_max: number | null
} {
  return {
    budget_min: normalizeOptionalInt(input.budget_min, 0, 10_000),
    budget_max: normalizeOptionalInt(input.budget_max, 0, 10_000),
    headcount: normalizeOptionalInt(input.headcount, 0, 10_000),
    settlement_min: normalizeOptionalInt(input.settlement_min, 0, 744),
    settlement_max: normalizeOptionalInt(input.settlement_max, 0, 744),
  }
}
