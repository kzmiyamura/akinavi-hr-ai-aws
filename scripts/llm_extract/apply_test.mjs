// llm_extract/apply_test.mjs — 上書きロジックの単体テスト
// 実行: node --test scripts/llm_extract/apply_test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  experienceYearsFromProjects, pickBodyFieldsFor, buildPatch, mergeSkills, techsFromProjects, unionMonths,
  isUsableName, genderMeaning, pickExperienceYears, sanitizeClaimedYears,
} from './apply.mjs'

test('isUsableName: 年齢・駅名を巻き込んだ氏名を弾く', () => {
  assert.equal(isUsableName('M.Y'), true)
  assert.equal(isUsableName('KM29蕨'), false)      // 実データで出た改悪例
  assert.equal(isUsableName(''), false)
  assert.equal(isUsableName(null), false)
  assert.equal(isUsableName('あ'.repeat(30)), false)
})

test('genderMeaning: 表記ゆれを同一視する', () => {
  assert.equal(genderMeaning('男'), genderMeaning('男性'))
  assert.equal(genderMeaning('女'), genderMeaning('女性'))
  assert.notEqual(genderMeaning('男'), genderMeaning('女'))
  assert.equal(genderMeaning(null), null)
})

test('fill方針のフィールドは既存値があれば触らない', () => {
  const cand = { desired_rate: '61～65万円', raw_profile: { nearestStation: '西新宿五丁目駅' } }
  const { patch } = buildPatch(cand, {
    bodyFields: { rate: '65万円', station: '月～都営大江戸線　西新宿五丁目駅' },
    attachment: null,
  })
  assert.equal(patch, null)   // どちらも既存値ありなので更新なし
})

test('employmentType「派遣社員」を壊さない（派遣許可チェックが完全一致依存）', () => {
  const cand = { raw_profile: { employmentType: '派遣社員' } }
  const { patch } = buildPatch(cand, { bodyFields: { employment: '1社先派遣社員' }, attachment: null })
  assert.equal(patch, null)
})

test('fill方針でも既存が空なら入る', () => {
  const cand = { desired_rate: null, raw_profile: {} }
  const { patch, changes } = buildPatch(cand, { bodyFields: { rate: '65万円' }, attachment: null })
  assert.equal(patch.desired_rate, '65万円')
  assert.deepEqual(changes, ['desired_rate'])
})

test('性別は意味が同じなら書き込まない（無駄なDB更新の削減）', () => {
  const cand = { raw_profile: { gender: '男性' } }
  const { patch } = buildPatch(cand, { bodyFields: { gender: '男' }, attachment: null })
  assert.equal(patch, null)
})

test('数字混じりのAI氏名は採用せず regex 名を守る', () => {
  const cand = { name: 'KM', raw_profile: {} }
  const { patch } = buildPatch(cand, { bodyFields: { name: 'KM29蕨' }, attachment: null })
  assert.equal(patch, null)
})

test('unionMonths: 重複期間は二重計上しない', () => {
  assert.equal(unionMonths([[1, 12], [6, 18]]), 18)      // 連続扱い
  assert.equal(unionMonths([[1, 12], [24, 35]]), 24)     // 離れていれば別々に加算
})

test('experienceYearsFromProjects: 暦unionで総年数を出す', () => {
  // 2015/01-2017/12 と 2017/01-2019/12 が重なる → 2015/01-2019/12 = 60ヶ月 = 5年
  assert.equal(experienceYearsFromProjects([
    { start: '2015/01', end: '2017/12' },
    { start: '2017/01', end: '2019/12' },
  ]), 5)
  assert.equal(experienceYearsFromProjects([]), null)
  assert.equal(experienceYearsFromProjects([{ start: 'x', end: 'y' }]), null)
  // 異常値は採用しない（グリッド誤読で1900年台などを拾った場合）
  assert.equal(experienceYearsFromProjects([{ start: '1900/01', end: '2026/01' }]), null)
})

test('pickBodyFieldsFor: 複数人メールで他人の値を掴まない', () => {
  const one = [{ name: 'A.B', age: 30 }]
  assert.equal(pickBodyFieldsFor('まったく別名', one).age, 30)   // 1件なら無条件採用

  const many = [{ name: 'C・Y', age: 40 }, { name: 'S・F', age: 50 }]
  assert.equal(pickBodyFieldsFor('S.F', many).age, 50)          // 区切り記号の揺れを吸収
  assert.equal(pickBodyFieldsFor('無関係', many), null)          // 特定できなければ null
  assert.equal(pickBodyFieldsFor('', many), null)

  // 同名が2件あるときも曖昧なので null（誤紐付け防止）
  assert.equal(pickBodyFieldsFor('K.T', [{ name: 'K.T' }, { name: 'K.T' }]), null)
})

test('buildPatch: AIが値を出せない項目は regex を残す', () => {
  const cand = {
    name: '旧名', experience_years: 3, desired_rate: '60万', from_company: '旧社',
    raw_profile: { age: 40, gender: '男', nearestStation: '東京' },
  }
  const { patch, changes } = buildPatch(cand, {
    bodyFields: { name: '新名', age: null, gender: null, station: null, rate: '70万', company: null },
    attachment: null,
  })
  assert.equal(patch.name, '新名')
  assert.equal(patch.desired_rate, undefined)          // fill方針＋既存値あり → 触らない
  assert.equal(patch.from_company, undefined)          // AIがnull → 触らない
  assert.equal(patch.raw_profile.age, 40)              // regex値が残る
  assert.equal(patch.raw_profile.nearestStation, '東京')
  assert.deepEqual(changes.sort(), ['name'])
})

test('buildPatch: 変更が無ければ DB を触らない（Supabase書き込み削減）', () => {
  const cand = { name: 'A', desired_rate: '60万', raw_profile: { age: 40 } }
  const { patch, changes } = buildPatch(cand, {
    bodyFields: { name: 'A', rate: '60万', age: 40 },
    attachment: null,
  })
  assert.equal(patch, null)
  assert.equal(changes.length, 0)
})

test('buildPatch: regex値を _regex_backup に退避し、再適用でも壊さない', () => {
  const cand = { name: '旧名', experience_years: 3, raw_profile: { skillYears: { Java: 99 } } }
  const first = buildPatch(cand, {
    bodyFields: { name: '新名' },
    attachment: { projects: [{ start: '2020/01', end: '2024/12', techs: ['Java'] }], skill_years: { Java: 60 } },
  })
  assert.equal(first.patch.raw_profile._regex_backup.name, '旧名')
  assert.deepEqual(first.patch.raw_profile._regex_backup.skillYears, { Java: 99 })
  assert.equal(first.patch.raw_profile._regex_backup.experience_years, 3)
  assert.equal(first.patch.experience_years, 5)
  assert.equal(first.patch.raw_profile.skillYears.Java, 60)

  // 2回目の上書きでも初回のregex値が保持されること
  const applied = { name: '新名', experience_years: 5, raw_profile: first.patch.raw_profile }
  const second = buildPatch(applied, {
    bodyFields: { name: 'さらに新名' },
    attachment: null,
  })
  assert.equal(second.patch.raw_profile._regex_backup.name, '旧名')
})

test('mergeSkills: skill_master にある未登録スキルだけ追加', () => {
  const master = new Set(['kotlin', 'java', 'rust'])
  assert.deepEqual(mergeSkills(['Java'], ['Kotlin', 'Java', '※項番4', 'Rust'], master), ['Java', 'Kotlin', 'Rust'])
  assert.equal(mergeSkills(['Java'], ['※項番4'], master), null)   // 追加なしなら null
  assert.equal(mergeSkills(['Java'], ['Java'], master), null)      // 重複は追加しない
})

test('techsFromProjects: 案件横断で重複排除', () => {
  assert.deepEqual(
    techsFromProjects([{ techs: ['Java', 'SQL'] }, { techs: ['Java', ' Kotlin '] }]),
    ['Java', 'SQL', 'Kotlin'],
  )
})

// ── 総経験年数: 案件表の計算値と自己PRの申告値の大きい方を採る（2026-08-10 ユーザー判断）──
// 案件表は前職・研修期間が載らず過小評価になる。HANDOFF_EXCEL_VERIFICATION.md の実例で
// IS 6年 vs 12年 / IT 2年 vs 6年 / KK 11年 vs 17年 と、いずれも案件表側が取りこぼしていた
test('sanitizeClaimedYears: 妥当な範囲だけ受け入れる', () => {
  assert.equal(sanitizeClaimedYears(6), 6)
  assert.equal(sanitizeClaimedYears('6年'), 6)      // 表記ゆれ
  assert.equal(sanitizeClaimedYears('業界6年目'), 6)
  assert.equal(sanitizeClaimedYears(0), null)        // 0年は読み違い
  assert.equal(sanitizeClaimedYears(61), null)       // 人の職歴として非現実的
  assert.equal(sanitizeClaimedYears(null), null)
  assert.equal(sanitizeClaimedYears('未記載'), null)
})

test('pickExperienceYears: 大きい方を採り、採用元を返す', () => {
  assert.deepEqual(pickExperienceYears(6, 12), { years: 12, source: 'claimed' })   // IS
  assert.deepEqual(pickExperienceYears(2, 6), { years: 6, source: 'claimed' })     // IT
  assert.deepEqual(pickExperienceYears(11, 17), { years: 17, source: 'claimed' })  // KK
  // 案件表の方が大きければそちら（申告が控えめなケース）
  assert.deepEqual(pickExperienceYears(20, 5), { years: 20, source: 'projects' })
  // 同値なら計算値を採用（根拠が明確な方）
  assert.deepEqual(pickExperienceYears(8, 8), { years: 8, source: 'projects' })
  // 片方しか無い場合
  assert.deepEqual(pickExperienceYears(null, 7), { years: 7, source: 'claimed' })
  assert.deepEqual(pickExperienceYears(9, null), { years: 9, source: 'projects' })
  assert.deepEqual(pickExperienceYears(null, null), { years: null, source: null })
  // 範囲外の申告は無視して計算値を残す
  assert.deepEqual(pickExperienceYears(5, 99), { years: 5, source: 'projects' })
})

test('buildPatch: 添付が無くても本文の申告値で経験年数を入れる', () => {
  const cand = { name: 'A.B', experience_years: 2, raw_profile: {} }
  const { patch, changes } = buildPatch(cand, {
    bodyFields: { experienceYears: 6 },
    attachment: null,
  })
  assert.equal(patch.experience_years, 6)
  assert.ok(changes.includes('experience_years'))
  assert.equal(patch.raw_profile._experience_source.source, 'claimed')
})

test('buildPatch: 案件表の方が大きければ申告値で下げない', () => {
  const cand = { name: 'A.B', experience_years: null, raw_profile: {} }
  const projects = [
    { start: '2006/01', end: '2025/12', techs: ['Java'] },   // 20年
  ]
  const { patch } = buildPatch(cand, {
    bodyFields: { experienceYears: 3 },
    attachment: { projects },
  })
  assert.equal(patch.experience_years, 20)
  assert.equal(patch.raw_profile._experience_source.source, 'projects')
})
