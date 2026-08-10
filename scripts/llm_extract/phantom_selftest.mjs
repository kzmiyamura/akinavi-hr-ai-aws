#!/usr/bin/env node
// phantom_selftest.mjs — 幽霊レコード判定（isPhantomRecord）の単体テスト
// 実行: node scripts/llm_extract/phantom_selftest.mjs
import { isUsableName } from './apply.mjs'

// shadow_worker.mjs の isPhantomRecord と同一ロジック（worker は env 必須のため import せず複製）。
// ロジックを変更したら両方を必ず合わせること。
function isPhantomRecord(c, bfCandidates) {
  const normName = (s) => String(s ?? '').replace(/[\s　・.,【】()（）]/g, '').toLowerCase()
  const bodyNames = (bfCandidates ?? []).filter((x) => isUsableName(x?.name)).map((x) => normName(x.name))
  if (bodyNames.length === 0) return false
  const mine = normName(c.name)
  if (!mine) return false
  const matchesBody = bodyNames.some((n) => n && (n === mine || n.includes(mine) || mine.includes(n)))
  if (matchesBody) return false
  const hasPersonAttr = !!(c.desired_rate || c.raw_profile?.age != null || c.raw_profile?.gender)
  return !hasPersonAttr
}

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) pass++
  else { fail++; console.log(`  FAIL ${label}: got=${got} expect=${expect}`) }
}

const body1 = [{ name: 'OMT', age: 72, gender: '男性' }]

// 幽霊: 本文はOMT1人だけ、この行は勤務地の駅名、属性なし
t('幽霊: 大手町（属性なし・本文に無い）',
  isPhantomRecord({ name: '大手町', desired_rate: null, raw_profile: {} }, body1), true)
t('幽霊: WEB（経歴書の見出し語）',
  isPhantomRecord({ name: 'WEB', desired_rate: null, raw_profile: {} }, body1), true)

// 実在: 本文の人物本人
t('実在: OMT本人',
  isPhantomRecord({ name: 'OMT', desired_rate: '50万', raw_profile: { age: 72 } }, body1), false)
t('実在: 表記ゆれ（OMT【大森】）も本文一致とみなす',
  isPhantomRecord({ name: 'OMT【大森】', desired_rate: null, raw_profile: {} }, body1), false)

// 実在: 名簿のみのメール（本文に人名なし）→ 判定しない（安全側）
t('安全側: 名簿のみメール由来は幽霊判定しない',
  isPhantomRecord({ name: '張 HG', desired_rate: null, raw_profile: {} }, []), false)

// 実在: 本文に無くても人の属性があれば実在扱い（複数人メールの別人など）
t('実在: 単価があれば幽霊にしない',
  isPhantomRecord({ name: '劉 B', desired_rate: '54万+精算', raw_profile: {} }, body1), false)
t('実在: 年齢があれば幽霊にしない',
  isPhantomRecord({ name: '金 HK', desired_rate: null, raw_profile: { age: 40 } }, body1), false)
t('実在: 性別があれば幽霊にしない',
  isPhantomRecord({ name: '趙HZ', desired_rate: null, raw_profile: { gender: '男性' } }, body1), false)

// 名前が無い場合は判定しない
t('安全側: 名前空は判定しない',
  isPhantomRecord({ name: '', desired_rate: null, raw_profile: {} }, body1), false)

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
