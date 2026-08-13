import { describe, it, expect } from 'vitest'
import { describeLlmChanges } from '../AiAppliedNote'

describe('describeLlmChanges', () => {
  it('AI補正が無ければ何も返さない', () => {
    expect(describeLlmChanges(null, null, {})).toEqual([])
    expect(describeLlmChanges({ fields: [] }, {}, {})).toEqual([])
  })

  it('上書き前の値（_regex_backup）と現在の値を対で返す', () => {
    const rows = describeLlmChanges(
      { at: '2026-08-12T07:25:24.097Z', model: 'haiku', fields: ['experience_years'] },
      { experience_years: 5 },
      { experience_years: 8 },
    )
    expect(rows).toEqual([
      { label: '経験年数', before: '5', after: '8', note: null },
    ])
  })

  it('regex が何も取れていなかった項目は before が null（「取得できず」で描画する）', () => {
    const rows = describeLlmChanges(
      { fields: ['age', 'gender'] },
      { age: null, gender: null },
      { age: 34, gender: '男性' },
    )
    expect(rows.map(r => [r.label, r.before, r.after])).toEqual([
      ['年齢', null, '34'],
      ['性別', null, '男性'],
    ])
  })

  it('配列・オブジェクトは件数に要約する（案件経歴やスキル年数を丸ごと出さない）', () => {
    const rows = describeLlmChanges(
      { fields: ['projects', 'skillYears'] },
      { projects: null, skillYears: { Java: 24 } },
      { projects: [{}, {}, {}], skillYears: { Java: 24, SQL: 12 } },
    )
    expect(rows.map(r => [r.label, r.before, r.after])).toEqual([
      ['案件経歴', null, '3件'],
      ['スキル年数', '1件', '2件'],
    ])
  })

  it('"skills(+5)" のような補足付きの表記からキーと補足を分ける', () => {
    const [row] = describeLlmChanges(
      { fields: ['skills(+5)'] },
      { skills: ['Java'] },
      { skills: ['Java', 'SQL', 'AWS', 'Linux', 'Git', 'Docker'] },
    )
    expect(row).toEqual({ label: 'スキル', before: '1件', after: '6件', note: '+5' })
  })

  it('全角括弧混じり（ワーカーが書く "required_skills(+1件・…）"）も分解できる', () => {
    const [row] = describeLlmChanges(
      { fields: ['required_skills(+1件・regexが0件のため補完）'] },
      { required_skills: null },
      { required_skills: ['PowerShell', 'Azure Functions'] },
    )
    expect(row.label).toBe('必須スキル')
    expect(row.before).toBeNull()
    expect(row.after).toBe('2件')
    expect(row.note).toBe('+1件・regexが0件のため補完')
  })

  it('ラベル未定義のキーはキー名をそのまま出す（隠さない）', () => {
    const [row] = describeLlmChanges({ fields: ['unknown_field'] }, {}, { unknown_field: 'x' })
    expect(row.label).toBe('unknown_field')
  })

  it('長い文字列は40文字で丸める', () => {
    const long = 'あ'.repeat(60)
    const [row] = describeLlmChanges({ fields: ['role_summary'] }, {}, { role_summary: long })
    expect(row.after).toBe(`${'あ'.repeat(40)}…`)
  })
})
