import { describe, it, expect } from 'vitest'
import { resolveScoringWeights } from '../MatchingInputs'
import { calcProjectWeights, DEFAULT_SCORING_WEIGHTS } from '../../lib/db/candidates'
import type { Project } from '../../lib/db/projects'

/**
 * 配点は「SQL の絞り込み・match-batch の内訳・画面表示」で食い違いやすい。
 * 画面に出す配点は、マッチング実行に渡す配点と必ず同じ解決順でなければならない。
 */
function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', title: '案件', client: null, description: null,
    required_skills: [], raw_data: null, status: 'open',
    budget_min: null, budget_max: null, work_location: null, work_prefecture: null,
    remote_policy: null, contract_type: null, required_experience_years: null,
    skill_weights: null, created_at: null, created_by: null,
    ...over,
  } as unknown as Project
}

describe('resolveScoringWeights', () => {
  it('保存済みウェイト（raw_data.matchWeights）があればそれを使う', () => {
    const w = resolveScoringWeights(project({
      raw_data: { matchWeights: { skill: 55, exp: 10, rate: 10, location: 15, remote: 10 } },
    }))
    expect(w).toEqual({ skill: 55, exp: 10, rate: 10, location: 15, remote: 10 })
  })

  it('保存済みウェイトが欠けている軸は既定値で埋める', () => {
    const w = resolveScoringWeights(project({ raw_data: { matchWeights: { skill: 50 } } }))
    expect(w).toEqual({ ...DEFAULT_SCORING_WEIGHTS, skill: 50 })
  })

  it('保存済みが無ければ案件内容から計算する（画面のハードコード 40/20/15/15/10 ではない）', () => {
    // 必須スキル5件 → スキル配点は 40 ではなく 50
    const p = project({ required_skills: ['基本設計', 'Microsoft 365', 'PowerShell', 'EntraID', 'Azure Functions'] })
    const w = resolveScoringWeights(p)
    expect(w).toEqual(calcProjectWeights(p))
    expect(w.skill).toBe(50)
  })

  it('skill が無い壊れた保存値は無視して計算にフォールバックする', () => {
    const p = project({ raw_data: { matchWeights: { exp: 30 } } })
    expect(resolveScoringWeights(p)).toEqual(calcProjectWeights(p))
  })
})
