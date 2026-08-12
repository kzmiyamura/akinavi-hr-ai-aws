import { describe, it, expect } from 'vitest'
import { projectToMatchRequirements, type Project } from '../projects'

const baseProject: Project = {
  id: 'p1',
  data_env: 'prod',
  title: 'テスト案件',
  client: 'A社',
  description: '説明',
  required_skills: ['Java', 'AWS'],
  budget_min: 50,
  budget_max: 70,
  start_date: '2026-06-01',
  end_date: null,
  work_location: '東京',
  remote_policy: '週2リモート',
  contract_type: '準委任',
  headcount: 2,
  workload: null,
  settlement_min: null,
  settlement_max: null,
  role_summary: 'SE',
  industry: '金融',
  raw_data: { niceToHaveSkills: ['Docker'] },
  // マッチングに使う項目（2026-08-12 追加）
  skill_weights: null,
  work_prefecture: null,
  required_experience_years: null,
  status: 'open',
  created_by: 'test',
  updated_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('projectToMatchRequirements', () => {
  it('DBの案件をマッチングAI入力形式に変換する', () => {
    const r = projectToMatchRequirements(baseProject)
    expect(r.title).toBe('テスト案件')
    expect(r.client).toBe('A社')
    expect(r.requiredSkills).toEqual(['Java', 'AWS'])
    expect(r.budgetMin).toBe(50)
    expect(r.budgetMax).toBe(70)
    expect(r.startDate).toBe('2026-06-01')
    expect(r.workLocation).toBe('東京')
    expect(r.remotePolicy).toBe('週2リモート')
    expect(r.niceToHaveSkills).toEqual(['Docker'])
  })

  it('niceToHaveSkills が無いときは空配列にする', () => {
    const r = projectToMatchRequirements({ ...baseProject, raw_data: {} })
    expect(r.niceToHaveSkills).toEqual([])
  })
})
