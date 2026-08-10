#!/usr/bin/env node
// probe_review_criteria.mjs — Sonnet を使わない前提で「needs_review にする基準」を比較する
//
// verify.mjs の判定は「Sonnet に昇格するか」を決めるために作られており、
// 引きが軽い（安く上げて上位モデルに直させる前提）。Sonnet を使わないなら
// これは「人が見るべきか」のフラグになるため、重い基準に組み直す必要がある。
//
// ワーカーログの haiku 判定行（pass / ESCALATE + 理由）を集計し、
// 基準ごとに「何%が要確認になるか」を出す。フラグは少なく・当たりが濃いほど良い。
//
// 使い方: node scripts/llm_extract/probe_review_criteria.mjs [日数=3]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DAYS = Number(process.argv[2] ?? 3)
const sinceMs = Date.now() - DAYS * 24 * 3600 * 1000

// verify.mjs の分類
const HARD = new Set(['no_projects', 'bad_dates', 'project_shortfall', 'month_label', 'self_low_confidence'])
/** 抽出が「壊れている」＝結果が使えない。人が見るしかない */
const BROKEN = new Set(['no_projects', 'bad_dates'])

const LINE = /^(\S+)\s+\[(.+?)\]\s+(haiku|sonnet): proj=(\d+) verify=(\S+)\s*(.*)$/
const rows = []   // {reasons:[], escalated:bool}
let logText = ''
try { logText = readFileSync(join(homedir(), 'akinavi_shadow.log'), 'utf8') } catch { /* ログ無し */ }
for (const line of logText.split('\n')) {
  const m = line.match(LINE)
  if (!m) continue
  const [, ts, , model, , verdict, rest] = m
  if (model !== 'haiku' || Date.parse(ts) < sinceMs) continue
  const reasons = rest.trim()
    ? rest.trim().split('|').map((r) => r.split('(')[0].trim()).filter(Boolean) : []
  rows.push({ reasons, escalated: verdict === 'ESCALATE' })
}

const pct = (n, d) => (d ? `${(n / d * 100).toFixed(0)}%` : '-')
const CRITERIA = [
  ['① 現行 primary（全ゲート＝今の一時停止の挙動）', (r) => r.length > 0],
  ['② final 相当（HARD_GATESのみ）', (r) => r.some((x) => HARD.has(x))],
  ['③ 自己申告を除く HARD', (r) => r.some((x) => HARD.has(x) && x !== 'self_low_confidence')],
  ['④ 壊れているものだけ（no_projects / bad_dates）', (r) => r.some((x) => BROKEN.has(x))],
]

console.log(`=== needs_review 基準の比較（直近${DAYS}日・haiku判定 ${rows.length}件）===`)
console.log('※Sonnetを使わない前提。フラグは「人が見るべき」の意味になる\n')
console.log('基準                                          要確認   割合')
console.log('-'.repeat(66))
for (const [label, fn] of CRITERIA) {
  const n = rows.filter((r) => fn(r.reasons)).length
  console.log(`${label.padEnd(44)} ${String(n).padStart(5)}  ${pct(n, rows.length).padStart(5)}`)
}

// 理由の出現数（どの基準が母数を作っているか）
const cnt = new Map()
for (const r of rows) for (const x of new Set(r.reasons)) cnt.set(x, (cnt.get(x) ?? 0) + 1)
console.log(`\n理由別の出現（延べ・1件に複数付く）`)
for (const [k, v] of [...cnt.entries()].sort((a, b) => b[1] - a[1])) {
  const kind = BROKEN.has(k) ? '壊れ' : HARD.has(k) ? 'hard' : 'soft'
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(4)}件  ${pct(v, rows.length).padStart(4)}  [${kind}]`)
}
