import { describe, it, expect } from 'vitest'
import {
  topSubmissionsPerProject,
  topSubmissionsPerCandidate,
  type SubmissionListPreviewRow,
} from '../submissions'

const rows: SubmissionListPreviewRow[] = [
  { project_id: 'p1', candidate_id: 'c1', match_score: 80, project_title: 'A', candidate_name: '山田' },
  { project_id: 'p1', candidate_id: 'c2', match_score: 90, project_title: 'A', candidate_name: '佐藤' },
  { project_id: 'p1', candidate_id: 'c3', match_score: 70, project_title: 'A', candidate_name: '鈴木' },
  { project_id: 'p1', candidate_id: 'c4', match_score: 85, project_title: 'A', candidate_name: '高橋' },
  { project_id: 'p2', candidate_id: 'c1', match_score: 60, project_title: 'B', candidate_name: '山田' },
]

describe('topSubmissionsPerProject', () => {
  it('案件ごとにスコア上位N件を返す', () => {
    const m = topSubmissionsPerProject(rows, 3)
    const p1 = m.get('p1')!
    expect(p1).toHaveLength(3)
    expect(p1[0].candidate_name).toBe('佐藤')
    expect(p1[0].match_score).toBe(90)
    expect(p1[1].match_score).toBe(85)
    expect(p1[2].match_score).toBe(80)
    expect(m.get('p2')).toHaveLength(1)
  })
})

describe('topSubmissionsPerCandidate', () => {
  it('人材ごとにスコア上位N件を返す', () => {
    const extra: SubmissionListPreviewRow[] = [
      ...rows,
      { project_id: 'p3', candidate_id: 'c1', match_score: 95, project_title: 'C', candidate_name: '山田' },
    ]
    const m = topSubmissionsPerCandidate(extra, 2)
    const c1 = m.get('c1')!
    expect(c1[0].match_score).toBe(95)
    expect(c1[1].match_score).toBe(80)
  })
})
