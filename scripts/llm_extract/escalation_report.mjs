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
// verify.mjs の HARD_GATES と同じ集合。Sonnet段でも同じ基準が適用されるため、
// これだけが引き金の昇格は「文書側の性質」であり上位モデルでは覆りにくい
const HARD = new Set(['no_projects', 'bad_dates', 'project_shortfall', 'month_label', 'self_low_confidence'])

let haikuTotal = 0
const escalations = []      // {name, triggers:[], outcome:'pass'|'bad'|null}
const pending = new Map()   // 名前 -> escalations のインデックス

let logText = ''
try { logText = readFileSync(join(homedir(), 'akinavi_shadow.log'), 'utf8') } catch { /* ログ無し */ }
for (const line of logText.split('\n')) {
  const m = line.match(LINE)
  if (!m) continue
  const [, ts, name, model, , verdict, rest] = m
  if (Date.parse(ts) < sinceMs) continue
  // 理由は "a|b" 形式。括弧の中身（実測値）は落として種類だけにする
  const names = rest.trim() ? rest.trim().split('|').map((r) => r.split('(')[0].trim()).filter(Boolean) : []
  if (model === 'haiku') {
    haikuTotal++
    if (verdict === 'ESCALATE') {
      pending.set(name, escalations.length)
      escalations.push({ name, triggers: names, outcome: null })
    }
  } else if (pending.has(name)) {
    escalations[pending.get(name)].outcome = verdict === 'pass' ? 'pass' : 'bad'
    pending.delete(name)
  }
}

// ── 理由ごと（延べ数。1回の昇格に複数付くため合計は昇格数を超える）──
const trigger = new Map(), wasted = new Map()
for (const e of escalations) {
  for (const n of e.triggers) {
    trigger.set(n, (trigger.get(n) ?? 0) + 1)
    if (e.outcome === 'bad') wasted.set(n, (wasted.get(n) ?? 0) + 1)
  }
}
console.log(`\n=== 昇格の引き金・延べ（haiku判定${haikuTotal}回中${escalations.length}回が昇格＝${pct(escalations.length, haikuTotal)}）===`)
for (const [k, v] of [...trigger.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(4)}回  うち昇格しても直らず ${String(wasted.get(k) ?? 0).padStart(3)}回` +
    `  ${HARD.has(k) ? '[hard]' : '[soft]'}`)
}

const judged = escalations.filter((e) => e.outcome)
const bad = judged.filter((e) => e.outcome === 'bad')
console.log(`\n=== 昇格して何が得られたか（結果が出た${judged.length}件）===`)
console.log(`  pass に転じた        : ${String(judged.length - bad.length).padStart(4)}回 ${pct(judged.length - bad.length, judged.length)}`)
console.log(`  NEEDS_REVIEW のまま  : ${String(bad.length).padStart(4)}回 ${pct(bad.length, judged.length)}  ← 昇格コストが無駄`)

// ── 単独引き金（重複を排した実際の削減余地）──
// 「hard だけが引き金」の昇格は、soft ゲートを残したまま止められる＝実際に削減できる母数。
// soft を含む昇格は tech_coverage 等の回収率が高いので止めない。
const surcharge = plain.length && esc.length ? mean(costOf(esc)) - mean(costOf(plain)) : 0
const hardOnly = judged.filter((e) => e.triggers.length && e.triggers.every((t) => HARD.has(t)))
const softAny = judged.filter((e) => e.triggers.some((t) => !HARD.has(t)))
const rate = (a) => `${a.filter((e) => e.outcome === 'pass').length}/${a.length} 回収 ${pct(a.filter((e) => e.outcome === 'pass').length, a.length)}`
console.log(`\n=== 引き金の種類で分けた回収率（重複なし・昇格1回=1件）===`)
console.log(`  hardのみが引き金 : ${String(hardOnly.length).padStart(4)}件  ${rate(hardOnly)}`)
console.log(`  softを含む       : ${String(softAny.length).padStart(4)}件  ${rate(softAny)}`)
if (surcharge) {
  const lose = hardOnly.filter((e) => e.outcome === 'pass').length
  console.log(`\n  → hardのみを昇格させない場合: ${hardOnly.length}件の昇格が消え ` +
    `約$${(surcharge * hardOnly.length).toFixed(2)} 削減（直近${DAYS}日）`)
  console.log(`     代償: そのうち回収できていた ${lose}件 が needs_review 止まりになる`)
}

// ── 引き金の組み合わせ別（どの組で止めるか決める用）──
console.log(`\n=== 引き金の組み合わせ別 回収率（上位10）===`)
const combos = new Map()
for (const e of judged) {
  const k = [...new Set(e.triggers)].sort().join(' + ') || '(理由なし)'
  if (!combos.has(k)) combos.set(k, [])
  combos.get(k).push(e)
}
for (const [k, list] of [...combos.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  const ok = list.filter((e) => e.outcome === 'pass').length
  console.log(`  ${String(list.length).padStart(3)}件 回収${pct(ok, list.length).padStart(4)}  ${k}`)
}
