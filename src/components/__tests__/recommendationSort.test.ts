import { describe, it, expect } from 'vitest'
import { verdictTier, compareByVerdictThenScore, getRecommendation } from '../RecommendationNote'

const raw = (verdict: string | null, pitch = '推薦文') => ({ recommendation: { verdict, pitch } })

describe('verdictTier', () => {
  it('推せる < 条件付き < 未評価 < 見送り の順', () => {
    expect(verdictTier(raw('推せる'))).toBeLessThan(verdictTier(raw('条件付き')))
    expect(verdictTier(raw('条件付き'))).toBeLessThan(verdictTier(null))
    expect(verdictTier(null)).toBeLessThan(verdictTier(raw('見送り')))
  })

  it('pitch の無い所見（出力不能の印）は未評価扱い', () => {
    expect(verdictTier({ recommendation: { at: 'x', skipped: '出力不能' } })).toBe(verdictTier(null))
  })
})

describe('compareByVerdictThenScore', () => {
  it('80点の推せるが 95点の条件付きより上に来る', () => {
    const a = { ai_raw: raw('推せる'), match_score: 80 }
    const b = { ai_raw: raw('条件付き'), match_score: 95 }
    expect([b, a].sort(compareByVerdictThenScore)[0]).toBe(a)
  })

  it('同じ段階なら点数の降順', () => {
    const a = { ai_raw: raw('条件付き'), match_score: 70 }
    const b = { ai_raw: raw('条件付き'), match_score: 90 }
    expect([a, b].sort(compareByVerdictThenScore)[0]).toBe(b)
  })

  it('見送りは未評価（所見なし）より下に沈む', () => {
    const okuri = { ai_raw: raw('見送り'), match_score: 99 }
    const none = { ai_raw: {}, match_score: 50 }
    expect([okuri, none].sort(compareByVerdictThenScore)[0]).toBe(none)
  })
})

describe('getRecommendation', () => {
  it('pitch が無ければ null（出力不能の印は表示しない）', () => {
    expect(getRecommendation({ recommendation: { at: 'x', skipped: 'y' } })).toBeNull()
    expect(getRecommendation(raw('推せる'))?.verdict).toBe('推せる')
  })
})
