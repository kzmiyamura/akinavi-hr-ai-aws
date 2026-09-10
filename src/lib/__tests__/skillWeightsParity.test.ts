/**
 * 必須スキルの重みの、フロント写しと本番（inbound-email）の一致テスト。
 *
 * 画面で必須スキルを編集したとき重みを組み直すため、式の写しを src/lib/skillWeights.ts に置いた（#185）。
 * 配点が2か所にあるとほぼ確実にズレるので、**index.ts から関数と表を切り出して**
 * 同じ入力に同じ答えを返すことを固定する（companyName.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSkillWeights, SKILL_CATEGORY_WEIGHT, SKILL_WEIGHT_MAX } from '../skillWeights'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadEdgeVersion() {
  const src = readFileSync(SRC, 'utf8')

  const table = src.match(/const SKILL_CATEGORY_WEIGHT: Record<string, number> = \{([\s\S]*?)\n\}/)
  if (!table) throw new Error('SKILL_CATEGORY_WEIGHT を index.ts から取り出せませんでした')

  const max = src.match(/const SKILL_WEIGHT_MAX = (\d+)/)
  if (!max) throw new Error('SKILL_WEIGHT_MAX を index.ts から取り出せませんでした')

  const fn = src.match(/export function buildSkillWeights\(([\s\S]*?)\n\}/)
  if (!fn) throw new Error('buildSkillWeights を index.ts から取り出せませんでした')

  const code = `
    const SKILL_CATEGORY_WEIGHT = {${table[1]}}
    const SKILL_WEIGHT_MAX = ${max[1]}
    ${`function buildSkillWeights(${fn[1]}\n}`
      .replace(/: string\[\]/g, '')
      .replace(/: \(skill: string\) => string \| null/g, '')
      .replace(/: Record<string, number\[\]>/g, '')
      .replace(/: Record<string, number>/g, '')}
    return { buildSkillWeights, SKILL_CATEGORY_WEIGHT, SKILL_WEIGHT_MAX }
  `
  return new Function(code)() as {
    buildSkillWeights: typeof buildSkillWeights
    SKILL_CATEGORY_WEIGHT: Record<string, number>
    SKILL_WEIGHT_MAX: number
  }
}

const edge = loadEdgeVersion()

describe('buildSkillWeights のフロント写しと本番の一致', () => {
  it('カテゴリの配点表が一致する', () => {
    expect(SKILL_CATEGORY_WEIGHT).toEqual(edge.SKILL_CATEGORY_WEIGHT)
  })

  it('上限が一致する', () => {
    expect(SKILL_WEIGHT_MAX).toBe(edge.SKILL_WEIGHT_MAX)
  })

  const CATEGORIES: Record<string, string> = {
    Java: 'languages', React: 'frameworks', Oracle: 'databases', AWS: 'clouds',
    Linux: 'os', Git: 'tools', 基本設計: 'methodologies', 英語: 'others',
  }
  const categoryOf = (s: string) => CATEGORIES[s] ?? null

  const CASES: Array<[string[], Record<string, number[]>]> = [
    [['Java', 'React', 'Oracle'], {}],
    [['Java', 'React'], { Java: [10] }],                 // 年数指定 +2
    [['基本設計', 'テスト', '保守開発'], {}],              // 工程語だけ
    [['Java'], { Java: [5, 10] }],                        // 先頭 +1 と年数 +2 で上限側
    [['AWS', 'Linux', 'Git', '英語'], { Git: [3] }],
    [['未知のスキル', 'Java'], {}],                        // カテゴリ不明は others 扱い
    [[], {}],
  ]

  it.each(CASES)('同じ入力に同じ重みを返す（%j）', (skills, years) => {
    expect(buildSkillWeights(skills, categoryOf, years))
      .toEqual(edge.buildSkillWeights(skills, categoryOf, years))
  })

  it('先頭ボーナスと年数ボーナスが効いている（式そのものの確認）', () => {
    const w = buildSkillWeights(['Java', 'React'], categoryOf, { React: [3] })
    expect(w.Java).toBe(5)   // languages 4 + 先頭 1
    expect(w.React).toBe(5)  // frameworks 3 + 年数 2
  })

  it('上限6を超えない', () => {
    const w = buildSkillWeights(['Java'], categoryOf, { Java: [10] })
    expect(w.Java).toBe(SKILL_WEIGHT_MAX)  // 4 + 2 + 1 = 7 → 6
  })
})
