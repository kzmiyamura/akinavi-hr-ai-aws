#!/usr/bin/env node
// paced_allowance_selftest.mjs — 日次上限のペース配分の単体テスト
//
// 上限だけを置くとワーカーは能力いっぱいで走り、朝の数時間で使い切って
// 営業時間中に届いた人材が当日処理されない（新しい順にした意味が消える）。
// ここでは「時刻に比例して配分される」ことと、境界で壊れないことを固定する。
//
// 実行: node scripts/llm_extract/paced_allowance_selftest.mjs
import { pacedAllowance } from './shadow_worker_lib.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) pass++
  else { fail++; console.log(`  FAIL ${label}  got=${got} exp=${expect}`) }
}
// 日境界は state.day と同じ UTC
const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 10, h, m))

t('UTC 0時ちょうどでも最低1件は動く', pacedAllowance(100, at(0)), 1)
t('6時間経過（1/4）で25件', pacedAllowance(100, at(6)), 25)
t('12時間経過（半分）で50件', pacedAllowance(100, at(12)), 50)
t('18時間経過（3/4）で75件', pacedAllowance(100, at(18)), 75)
t('23:59 でほぼ上限', pacedAllowance(100, at(23, 59)), 100)

// 上限そのものを超えない
t('上限を超えない', pacedAllowance(100, at(23, 59)) <= 100, true)
t('小さい上限でも1件は動く', pacedAllowance(1, at(0)), 1)
t('上限1は常に1', pacedAllowance(1, at(23)), 1)

// 端数は切り上げ（待ちすぎて何も進まない状態を避ける）
t('1時間経過で切り上げ5件', pacedAllowance(100, at(1)), 5)
t('上限10・6時間で3件', pacedAllowance(10, at(6)), 3)

// 実運用の意味: 100件/日なら1時間あたり約4件ペース
t('9時間経過で約38件（4件/時ペース）', pacedAllowance(100, at(9)), 38)

// ── 本文LLMを省略してよいかの判定 ──
// 添付が無い人材は本文が唯一の情報源。regexが主要項目を埋めていても省略してはいけない
// （実測: _experience_source 45件中、申告値が入ったのは2件だけ。うちT.Aは
//  案件表6年 vs 申告24年で18年分の取りこぼしが埋まった・2026-08-11）
const { shouldSkipBodyLlm } = await import('./shadow_worker_lib.mjs')
t('添付あり＋充足 → 省略する', shouldSkipBodyLlm('https://x/a.xlsx', true), true)
t('添付あり＋不足 → 省略しない', shouldSkipBodyLlm('https://x/a.xlsx', false), false)
t('添付なし＋充足 → 省略しない（本文が唯一の情報源）', shouldSkipBodyLlm(null, true), false)
t('添付なし＋不足 → 省略しない', shouldSkipBodyLlm(null, false), false)
t('pdfも添付として扱う', shouldSkipBodyLlm('https://x/a.pdf', true), true)
t('docxも添付として扱う', shouldSkipBodyLlm('https://x/a.docx', true), true)
t('解析できない拡張子は添付とみなさない', shouldSkipBodyLlm('https://x/a.jpg', true), false)
t('クエリ付きURLでも判定できる', shouldSkipBodyLlm('https://x/a.xlsx?token=1', true), true)

console.log(`
📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
