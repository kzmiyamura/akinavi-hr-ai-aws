#!/usr/bin/env node
// escalation_report.mjs — 経歴書解析(attachment)の Sonnet 昇格が「いくらかかって何を買ったか」
//
// 消費の大半は経歴書解析で、その単価を押し上げているのは Haiku→Sonnet の昇格
// （昇格すると haiku + sonnet の両方を払う）。
// 昇格しても needs_review のまま終わるケースは、払っただけで何も得ていない。
//
//   コスト  … llm_shadow（model='sonnet' の cost_usd は haiku+sonnet の合算）
//   引き金  … ワーカーログの "verify=ESCALATE <理由>"（DBの reasons は
//             昇格後の最終判定しか持たないため、引き金はログにしか無い）
//
// 使い方: node scripts/llm_extract/escalation_report.mjs [日数=3]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DAYS = Number(process.argv[2] ?? 3)
const sinceMs = Date.now() - DAYS * 24 * 3600 * 1000
const since = new Date(sinceMs).toISOString()

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const mean = (a) => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : 0)
const pct = (n, d) => (d ? `${(n / d * 100).toFixed(0)}%` : '-')

// ── ① コスト構成（llm_shadow）──
const rows = (await fetchAll(
  `llm_shadow?select=source,model,status,cost_usd,ms,created_at&created_at=gte.${since}`))
  .filter((r) => r.source === 'attachment' && r.status !== 'error')

const plain = rows.filter((r) => r.model !== 'sonnet')
const esc = rows.filter((r) => r.model === 'sonnet')
const costOf = (a) => a.map((r) => r.cost_usd ?? 0)
const sum = (a) => costOf(a).reduce((n, v) => n + v, 0)

console.log(`=== 経歴書解析(attachment)のコスト構成（直近${DAYS}日・成功${rows.length}件）===`)
console.log(`  haiku止まり : ${String(plain.length).padStart(4)}回  平均$${mean(costOf(plain)).toFixed(4)}  合計$${sum(plain).toFixed(2)}`)
console.log(`  sonnet昇格  : ${String(esc.length).padStart(4)}回  平均$${mean(costOf(esc)).toFixed(4)}  合計$${sum(esc).toFixed(2)}`)
const totalCost = sum(rows)
console.log(`  昇格率 ${pct(esc.length, rows.length)} / 昇格分が全コストに占める割合 ${pct(sum(esc), totalCost)}`)
if (plain.length && esc.length) {
  console.log(`  昇格1回あたりの上乗せ ≒ $${(mean(costOf(esc)) - mean(costOf(plain))).toFixed(4)}` +
    `（$${mean(costOf(plain)).toFixed(4)} → $${mean(costOf(esc)).toFixed(4)}）`)
}

// ── ② 昇格の引き金と結果（ワーカーログ）──
// 例: "  [名前] haiku: proj=2 verify=ESCALATE tech_coverage(0.17,grid=6)"
//     "  [名前] sonnet: proj=2 verify=NEEDS_REVIEW self_low_confidence"
const LINE = /^(\S+)\s+\[(.+?)\]\s+(haiku|sonnet): proj=(\d+) verify=(\S+)\s*(.*)$/
const trigger = new Map()   // 理由名 -> 回数
let haikuTotal = 0, escalated = 0, resolved = 0, stillBad = 0
const pending = new Map()   // 名前 -> 引き金の理由リスト
const wasted = new Map()    // 理由名 -> 昇格しても直らなかった回数

let logText = ''
try { logText = readFileSync(join(homedir(), 'akinavi_shadow.log'), 'utf8') } catch { /* ログ無し */ }
for (const line of logText.split('\n')) {
  const m = line.match(LINE)
  if (!m) continue
  const [, ts, name, model, , verdict, rest] = m
  if (Date.parse(ts) < sinceMs) continue
  // 理由は "a|b" 形式。括弧の中身（実測値）は落として種類だけ数える
  const names = rest.trim() ? rest.trim().split('|').map((r) => r.split('(')[0].trim()).filter(Boolean) : []
  if (model === 'haiku') {
    haikuTotal++
    if (verdict === 'ESCALATE') {
      escalated++
      for (const n of names) trigger.set(n, (trigger.get(n) ?? 0) + 1)
      pending.set(name, names)
    }
  } else {
    const trig = pending.get(name) ?? []
    pending.delete(name)
    if (verdict === 'pass') resolved++
    else {
      stillBad++
      for (const n of trig) wasted.set(n, (wasted.get(n) ?? 0) + 1)
    }
  }
}

console.log(`\n=== 昇格の引き金（ワーカーログ・haiku判定${haikuTotal}回中${escalated}回が昇格＝${pct(escalated, haikuTotal)}）===`)
for (const [k, v] of [...trigger.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(4)}回  うち昇格しても直らず ${String(wasted.get(k) ?? 0).padStart(3)}回`)
}

const judged = resolved + stillBad
console.log(`\n=== 昇格して何が得られたか（結果が出た${judged}件）===`)
console.log(`  pass に転じた        : ${String(resolved).padStart(4)}回 ${pct(resolved, judged)}`)
console.log(`  NEEDS_REVIEW のまま  : ${String(stillBad).padStart(4)}回 ${pct(stillBad, judged)}  ← 昇格コストが無駄`)
if (judged && plain.length && esc.length) {
  const surcharge = mean(costOf(esc)) - mean(costOf(plain))
  console.log(`  無駄になった昇格の推定額: $${(surcharge * stillBad).toFixed(2)}` +
    `（上乗せ$${surcharge.toFixed(4)} × ${stillBad}回）`)
}
