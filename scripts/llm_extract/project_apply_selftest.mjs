#!/usr/bin/env node
// project_apply.mjs の単体テスト（node scripts/llm_extract/project_apply.test.mjs で実行）
import { buildProjectPatch, parseStartDate } from './project_apply.mjs'
import { normTech } from './lib.mjs'

let pass = 0, fail = 0
const t = (label, cond) => {
  if (cond) { pass++ } else { fail++; console.log(`  FAIL ${label}`) }
}

const SM = new Set(['java', 'python', 'aws', 'spring'].map(normTech))

// 1. fill: 既存値があれば触らない
{
  const p = { title: '既存案件名', client: 'A社', budget_min: 60, required_skills: ['Java'], raw_data: {} }
  const { patch, changes } = buildProjectPatch(p, { title: 'AI案件', client: 'B社', rateMin: 70 }, SM)
  t('fill: 既存title/client/budgetを触らない', patch === null && changes.length === 0)
}

// 2. fill: 空欄は埋める
{
  const p = { title: '既存', client: null, budget_min: null, required_skills: [], raw_data: {} }
  const { patch, changes } = buildProjectPatch(p, { client: '株式会社X', rateMin: 60, rateMax: 70 }, SM)
  t('fill: 空のclient/budgetを埋める', patch.client === '株式会社X' && patch.budget_min === 60 && patch.budget_max === 70)
  t('fill: backupに旧値(null)を退避', patch.raw_data._regex_backup.client === null)
  t('fill: _llm_applied.fields 記録', patch.raw_data._llm_applied.fields.includes('client'))
  t('fill: changesに含む', changes.includes('budget_min'))
}

// 3. title: フォールバック「案件」は空扱いで置換
{
  const p = { title: '案件', required_skills: [], raw_data: {} }
  const { patch } = buildProjectPatch(p, { title: 'Java基幹システム更改' }, SM)
  t('title: 「案件」は置換', patch.title === 'Java基幹システム更改')
}

// 4. required_skills: skill_master にあるものだけ追加・既存は消さない
{
  const p = { title: 'x', required_skills: ['Java'], raw_data: {} }
  const { patch } = buildProjectPatch(p, { requiredSkills: ['Java', 'Python', '謎スキル', 'AWS'] }, SM)
  t('skills: master照合で追加', JSON.stringify(patch.required_skills) === JSON.stringify(['Java', 'Python', 'AWS']))
}

// 5. 数値ガード: 異常値は捨てる
{
  const p = { title: 'x', budget_min: null, headcount: null, required_skills: [], raw_data: {} }
  const { patch } = buildProjectPatch(p, { rateMin: 9999, headcount: 0 }, SM)
  t('数値ガード: 単価9999万・人数0は捨てる', patch === null)
}

// 6. parseStartDate
t('date: 2026/09 → 2026-09-01', parseStartDate('2026/09') === '2026-09-01')
t('date: 2026年10月〜 → 2026-10-01', parseStartDate('2026年10月〜') === '2026-10-01')
t('date: 即日 → null', parseStartDate('即日') === null)
t('date: 9月〜（年なし）→ null', parseStartDate('9月〜') === null)

// 7. requiredSkillYears の形式ガード
{
  const p = { title: 'x', required_skills: [], raw_data: {} }
  const { patch } = buildProjectPatch(p, { requiredSkillYears: { Java: [5], '': [3], PHP: ['x'] } }, SM)
  t('skillYears: 妥当なキーのみ採用', JSON.stringify(patch.raw_data.requiredSkillYears) === JSON.stringify({ Java: [5] }))
}

// 7.5 remote_policy: リモート関連語を含まない値は捨てる
{
  const p = { title: 'x', remote_policy: null, required_skills: [], raw_data: {} }
  const r1 = buildProjectPatch(p, { remotePolicy: '派遣が必要' }, SM)
  t('remote: 「派遣が必要」は捨てる', r1.patch === null)
  const r2 = buildProjectPatch(p, { remotePolicy: '週1出社（他リモート）' }, SM)
  t('remote: 「週1出社」は受理', r2.patch.remote_policy === '週1出社（他リモート）')
}

// 8. 2回目適用でも backup は初回値を保持
{
  const p = { title: 'x', client: null, required_skills: [], raw_data: { _regex_backup: { client: '初回値' } } }
  const { patch } = buildProjectPatch(p, { client: '2回目' }, SM)
  t('backup: 初回値を上書きしない', patch.raw_data._regex_backup.client === '初回値')
}

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
