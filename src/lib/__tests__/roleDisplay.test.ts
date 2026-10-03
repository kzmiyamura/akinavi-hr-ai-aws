import { describe, it, expect } from 'vitest'
import { splitRoles, mainJob, isLeadershipRole, leadershipLabel, LEADERSHIP_ROLES } from '../roleDisplay'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('roleDisplay', () => {
  it('立場と職種を分け、並び順（スコア降順）を保つ', () => {
    const { jobs, leadership } = splitRoles([
      'プロジェクトリーダー', 'バックエンドエンジニア', 'PMO', 'システムエンジニア',
    ])
    expect(jobs).toEqual(['バックエンドエンジニア', 'システムエンジニア'])
    expect(leadership).toEqual(['プロジェクトリーダー', 'PMO'])
  })

  it('職種が無い人（実測309人）は jobs が空で leadership だけ残る', () => {
    const { jobs, leadership } = splitRoles(['プロジェクトリーダー', 'PMO'])
    expect(jobs).toEqual([])
    expect(leadership).toEqual(['プロジェクトリーダー', 'PMO'])
    expect(mainJob(['プロジェクトリーダー'])).toBeNull()
  })

  it('null や空配列でも両方の配列を返す（呼ぶ側に分岐を作らせない）', () => {
    expect(splitRoles(null)).toEqual({ jobs: [], leadership: [] })
    expect(splitRoles(undefined)).toEqual({ jobs: [], leadership: [] })
    expect(splitRoles([])).toEqual({ jobs: [], leadership: [] })
    expect(mainJob(null)).toBeNull()
  })

  it('コンサルタントとアーキテクトは職種側に残す（ラベルに作用対象が入っている）', () => {
    expect(isLeadershipRole('コンサルタント')).toBe(false)
    expect(isLeadershipRole('アーキテクト')).toBe(false)
    expect(splitRoles(['コンサルタント']).jobs).toEqual(['コンサルタント'])
  })

  it('経験欄の表記は「〜経験」になる', () => {
    expect(leadershipLabel('プロジェクトリーダー')).toBe('リーダー経験')
    expect(leadershipLabel('プロジェクトマネージャー')).toBe('PM経験')
    expect(leadershipLabel('PMO')).toBe('PMO経験')
    // 対象外の役割はそのまま返す（表示が空にならないこと）
    expect(leadershipLabel('システムエンジニア')).toBe('システムエンジニア')
  })

  it('立場として扱うラベルは inbound-email の ROLE_DEFS に実在する', () => {
    // 綴りがズレると分類が黙って効かなくなる。本番の定義そのものと突き合わせる
    const src = readFileSync(
      resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'),
      'utf-8',
    )
    const labels = new Set(
      [...src.matchAll(/label:\s*'([^']+)'/g)].map(m => m[1]),
    )
    for (const r of LEADERSHIP_ROLES) {
      expect(labels.has(r), `ROLE_DEFS に「${r}」が無い`).toBe(true)
    }
  })
})
