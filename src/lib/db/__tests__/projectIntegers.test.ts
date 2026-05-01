import { describe, it, expect } from 'vitest'
import { normalizeProjectIntegerColumns } from '../projectIntegers'

describe('normalizeProjectIntegerColumns', () => {
  it('小数は切り捨てて保存できる整数にする', () => {
    expect(
      normalizeProjectIntegerColumns({
        budget_min: 55.9,
        budget_max: 60.1,
        headcount: 2.9,
        settlement_min: 21.5,
        settlement_max: 180.9,
      }),
    ).toEqual({
      budget_min: 55,
      budget_max: 60,
      headcount: 2,
      settlement_min: 21,
      settlement_max: 180,
    })
  })

  it('範囲外は null にする', () => {
    expect(
      normalizeProjectIntegerColumns({
        budget_min: -1,
        budget_max: 200_000,
        headcount: -1,
        settlement_min: 800,
        settlement_max: -10,
      }),
    ).toEqual({
      budget_min: null,
      budget_max: null,
      headcount: null,
      settlement_min: null,
      settlement_max: null,
    })
  })
})
