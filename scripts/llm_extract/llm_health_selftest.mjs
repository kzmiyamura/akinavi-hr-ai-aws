#!/usr/bin/env node
// llm_health_selftest.mjs — 「AI が止まったらメール」の判定の単体テスト（メールは送らない）
//
// 実行: node scripts/llm_extract/llm_health_selftest.mjs
process.env.LLM_HEALTH_STATE = process.env.LLM_HEALTH_STATE || '/nonexistent-dir/llm_health_test.json'
const { emptyHealth, applyResult, decide, markSent, buildMail, isTransientError, DOWN_AFTER_MS, REMIND_EVERY_MS } =
  await import('./llm_health.mjs')

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) pass++
  else { fail++; console.log(`  FAIL ${label}  got=${got} exp=${expect}`) }
}
const MIN = 60 * 1000
// 2026-11-23〜25 の実物（ログイン切れ）。API に届く前に落ちるので duration_api_ms が 0
const LOGIN_ERR = 'exit=1 {"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"89aa8ad8","total_cost_usd":0}'

/** 5分おきに2回ずつ失敗させる（所見の2件が毎サイクル落ちていたのと同じ形） */
const failFor = (h, startMs, minutes) => {
  for (let m = 0; m <= minutes; m += 5) {
    h = applyResult(h, false, LOGIN_ERR, startMs + m * MIN)
    h = applyResult(h, false, LOGIN_ERR, startMs + m * MIN + 3000)
  }
  return h
}

const T0 = Date.UTC(2026, 10, 23, 0, 0)
let h = applyResult(emptyHealth(), true, null, T0 - MIN)

// 鳴らない
t('失敗が始まって25分ではまだ鳴らない', decide(failFor(h, T0, 25), T0 + 25 * MIN), null)
t('30分経っても失敗4回なら鳴らない', decide(
  [1, 2, 3, 4].reduce((s, i) => applyResult(s, false, LOGIN_ERR, T0 + i * 10 * MIN), h), T0 + 40 * MIN), null)
t('途中で1回でも成功すれば数え直し', decide(
  applyResult(failFor(h, T0, 25), true, null, T0 + 26 * MIN), T0 + 31 * MIN), null)
t('timeout は数えない', isTransientError(new Error('timeout')), true)
t('JSON の読み取り失敗は数えない', isTransientError(new SyntaxError('Unexpected token')), true)
t('exit=1 は数える', isTransientError(new Error(LOGIN_ERR)), false)

// 鳴る
let down = failFor(h, T0, 30)
t('成功なしで30分・失敗5回以上なら down', decide(down, T0 + 30 * MIN), 'down')
down = markSent(down, 'down', T0 + 30 * MIN)
t('送ったあとは連発しない（5分後）', decide(failFor(down, T0 + 35 * MIN, 0), T0 + 35 * MIN), null)
t('12時間経っても直らなければ再送', decide(down, T0 + 30 * MIN + REMIND_EVERY_MS), 'reminder')
const rem = markSent(down, 'reminder', T0 + 30 * MIN + REMIND_EVERY_MS)
t('再送のあとはまた12時間あける', decide(rem, T0 + 30 * MIN + REMIND_EVERY_MS + 60 * MIN), null)

// 復旧
let up = applyResult(down, true, null, T0 + 50 * 60 * MIN)
t('鳴ったあとに成功したら recovered', decide(up, T0 + 50 * 60 * MIN), 'recovered')
up = markSent(up, 'recovered', T0 + 50 * 60 * MIN)
t('復旧メールは1通だけ', decide(up, T0 + 51 * 60 * MIN), null)
t('復旧後は警報状態が消える', up.alertedAt, null)
t('鳴っていないときの成功では復旧メールを出さない', decide(applyResult(h, true, null, T0), T0), null)
t('復旧後にまた止まれば、もう一度 down が鳴る', decide(failFor(up, T0 + 52 * 60 * MIN, 30), T0 + 52 * 60 * MIN + DOWN_AFTER_MS), 'down')

// 本文
const m = buildMail('down', failFor(h, T0, 30), T0 + 30 * MIN)
t('ログイン切れの形なら /login を案内する', m.text.includes('/login'), true)
t('件名で止まったと分かる', m.subject.includes('止まっています'), true)
t('枠切れなど別の失敗では /login と決めつけない',
  buildMail('down', applyResult(h, false, 'exit=1 usage limit reached', T0), T0).text.includes('/login'), false)

console.log(`llm_health: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
