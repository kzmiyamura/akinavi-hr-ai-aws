#!/usr/bin/env node
// buildInterpretationPatch の純関数テスト（LLM・DB 不要）
// 実行: node scripts/llm_extract/test_interpretation_patch.mjs
import { buildInterpretationPatch } from './project_apply.mjs'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++ } else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`) }
}

const master = new Set(['activedirectory', 'intune', 'exchangeonline', 'azure'])
const baseProj = {
  required_skills: ['Azure Functions', 'PowerShell'],
  raw_data: { niceToHaveSkills: ['Microsoft 365'] },
}
const baseR = {
  model: 'haiku', confidence: 'high', multiPerson: true, evidence: '2名セットでの参画を想定',
  relatedSkills: [
    { name: 'Active Directory', reason: 'Windows運用に必須' },
    { name: 'Intune', reason: 'デバイス管理' },
    { name: 'ドキュメント作成', reason: '抽象語' },        // skill_master に無い → 落とす
    { name: 'Microsoft 365', reason: '既に尚可にある' },    // 重複 → 落とす（master に無いが重複判定が先）
    { name: 'azure  ', reason: '空白・大小文字ゆれ' },
  ],
}

// 1. 通常ケース: master にあり重複しないものだけ尚可に統合
{
  const { patch, changes } = buildInterpretationPatch(baseProj, baseR, master)
  const rd = patch.raw_data
  eq('尚可への統合', rd.niceToHaveSkills, ['Microsoft 365', 'Active Directory', 'Intune', 'azure'])
  eq('backup に元の尚可', rd._regex_backup.niceToHaveSkills, ['Microsoft 365'])
  eq('aiInterpretation.relatedSkills', rd.aiInterpretation.relatedSkills.map(x => x.name),
    ['Active Directory', 'Intune', 'azure'])
  eq('multiPerson', rd.aiInterpretation.multiPerson, true)
  eq('evidence', rd.aiInterpretation.evidence, '2名セットでの参画を想定')
  eq('changes', changes, ['関連スキル+3(尚可扱い)', '複数名前提'])
}

// 2. 必須スキルと重複する関連スキルは落とす
{
  const r = { ...baseR, multiPerson: false, relatedSkills: [{ name: 'PowerShell', reason: '必須に既にある' }] }
  const { patch, changes } = buildInterpretationPatch(baseProj, r, master)
  eq('必須との重複は不採用', patch.raw_data.aiInterpretation.relatedSkills, [])
  eq('尚可は変えない', patch.raw_data.niceToHaveSkills, ['Microsoft 365'])
  eq('changes 空', changes, [])
}

// 3. confidence=low は記録のみ・適用しない
{
  const r = { ...baseR, confidence: 'low' }
  const { patch, changes } = buildInterpretationPatch(baseProj, r, master)
  eq('low: 尚可は変えない', patch.raw_data.niceToHaveSkills, ['Microsoft 365'])
  eq('low: multiPerson は立てない', patch.raw_data.aiInterpretation.multiPerson, false)
  eq('low: changes', changes, ['低確信のため未適用'])
  eq('low: 印は必ず付く', typeof patch.raw_data.aiInterpretation.at, 'string')
}

// 4. 結果ゼロでも印（aiInterpretation）は書く
{
  const r = { model: 'haiku', confidence: 'high', multiPerson: false, evidence: null, relatedSkills: [] }
  const { patch, changes } = buildInterpretationPatch(baseProj, r, master)
  eq('ゼロ件でも patch あり', !!patch.raw_data.aiInterpretation, true)
  eq('ゼロ件の changes', changes, [])
}

// 5. 既存 _regex_backup の niceToHaveSkills は上書きしない（最初の値が正）
{
  const p = { ...baseProj, raw_data: { niceToHaveSkills: ['X'], _regex_backup: { niceToHaveSkills: ['元の値'] } } }
  const r = { ...baseR, relatedSkills: [{ name: 'Intune', reason: 'r' }] }
  const { patch } = buildInterpretationPatch(p, r, master)
  eq('backup は据え置き', patch.raw_data._regex_backup.niceToHaveSkills, ['元の値'])
}

// 6. 8件で頭打ち
{
  const bigMaster = new Set(Array.from({ length: 20 }, (_, i) => `skill${i}`))
  const r = { ...baseR, relatedSkills: Array.from({ length: 20 }, (_, i) => ({ name: `Skill${i}`, reason: 'r' })) }
  const { patch } = buildInterpretationPatch({ required_skills: [], raw_data: {} }, r, bigMaster)
  eq('上限8件', patch.raw_data.aiInterpretation.relatedSkills.length, 8)
}

console.log(`${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
