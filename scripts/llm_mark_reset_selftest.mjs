#!/usr/bin/env node
// llm_mark_reset_selftest.mjs — 既存レコードを上書きしたとき AI校正の印を引き継がないこと
//
// ワーカーは「_llm_checked_at が無い人」をキューに拾う。上書きで印が残ると、
// 中身だけ新しくなった人が二度と校正されない
// （2026-08-16 フォスターネット16件。年齢 null の3人が埋まらない直接の原因）。
// 一方、後続ブロックの劣化データが確定済みの値を null で潰さないためのマージは維持する。
//
// 使い方: node scripts/llm_mark_reset_selftest.mjs
import { mergeRawProfileOnUpdate } from './_extractors.gen.mjs'

let ng = 0
const check = (label, cond, got) => {
  if (cond) console.log(`OK   ${label}`)
  else { ng++; console.log(`NG   ${label} → ${JSON.stringify(got)}`) }
}

const existing = {
  age: 42,
  nearestStation: '初台駅',
  prefecture: '東京都',
  subject: '旧件名',
  _llm_checked_at: '2026-08-10T13:02:21.964Z',
  _llm_stage: 'done',
  _llm_applied: { at: '2026-08-10T13:02:21.964Z', model: 'haiku', fields: ['age'] },
  _llm_attempts: 2,
  _llm_last_error: 'fetch failed',
  _regex_backup: { age: null },
}
const fresh = { age: null, nearestStation: '松戸駅', prefecture: null, subject: '新件名' }
const merged = mergeRawProfileOnUpdate(existing, fresh)

check('AI校正の印を引き継がない', merged._llm_checked_at === undefined, merged._llm_checked_at)
check('進行印も残さない', merged._llm_stage === undefined, merged._llm_stage)
check('適用履歴も残さない', merged._llm_applied === undefined, merged._llm_applied)
check('失敗回数も残さない', merged._llm_attempts === undefined, merged._llm_attempts)
check('最終エラーも残さない', merged._llm_last_error === undefined, merged._llm_last_error)
check('校正前バックアップも残さない', merged._regex_backup === undefined, merged._regex_backup)

check('今回取れた値で上書きする', merged.nearestStation === '松戸駅', merged.nearestStation)
check('今回 null の値は既存を残す（age）', merged.age === 42, merged.age)
check('今回 null の値は既存を残す（prefecture）', merged.prefecture === '東京都', merged.prefecture)
check('今回の値が優先される（subject）', merged.subject === '新件名', merged.subject)

// 既存が空でも壊れない
const m2 = mergeRawProfileOnUpdate({}, { age: 30 })
check('既存が空でも今回の値を返す', m2.age === 30, m2)
// 印が今回側にしか無い場合も消す（LLM由来の再投入を素通ししない）
const m3 = mergeRawProfileOnUpdate({}, { age: 30, _llm_checked_at: '2026-08-16T00:00:00Z' })
check('今回側に印があっても消す', m3._llm_checked_at === undefined, m3._llm_checked_at)

console.log(`\n${ng === 0 ? '全ケース通過' : `${ng}件 失敗`}`)
process.exit(ng ? 1 : 0)
