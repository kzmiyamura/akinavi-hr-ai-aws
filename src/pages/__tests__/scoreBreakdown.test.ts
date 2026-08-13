import { describe, it, expect } from 'vitest'
import { parseSavedSkillHits } from '../MatchingPage'

/**
 * 保存済みの内訳と、画面の緑バッジ（live 判定）が食い違ったときに
 * 「保存時いくつ・最新でいくつ」を出すための読み取り。
 * 実データで「緑が5個中4個あるのに内訳は3合致」と出ていた（2026-08-13 指摘）。
 */
describe('parseSavedSkillHits', () => {
  it('内訳テキストから保存時の合致数を読む', () => {
    const line = 'スキル23/40(必須5中3合致) 経験15/15(総経験10年) 単価20/20(65万円 ※応相談) → 計88pt'
    expect(parseSavedSkillHits(line)).toEqual({ total: 5, hits: 3 })
  })

  it('合致したスキル名が並ぶ新しい形式でも読める', () => {
    const line = 'スキル30/40(必須5中4合致:基本設計・Microsoft 365・PowerShell・EntraID・尚可2中0合致)'
    expect(parseSavedSkillHits(line)).toEqual({ total: 5, hits: 4 })
  })

  it('必須スキルが無い案件など、読めない内訳では null', () => {
    expect(parseSavedSkillHits('経験15/15(総経験10年) → 計55pt')).toBeNull()
  })
})
