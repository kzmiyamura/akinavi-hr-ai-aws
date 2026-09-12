#!/usr/bin/env node
/**
 * ローカル控え（archive_local.mjs が貯めたJSONL）を集計する。**本番は一切引かない。**
 *
 *   node scripts/archive_query.mjs summary                 # 全体の内訳
 *   node scripts/archive_query.mjs daily                   # 日別の登録数と品質
 *   node scripts/archive_query.mjs company [上位N]          # 送信元会社ごとの件数と品質
 *   node scripts/archive_query.mjs missed                  # 取りこぼし（登録されなかったメール）
 *
 * 人材は7日で本番から消えるが、ここには残る。
 * 「先月と比べてどうか」を調べるのに egress を使わなくて済むのが狙い。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ARCHIVE_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))

function* rows(table) {
  const dir = join(ARCHIVE_DIR, table)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

const pct = (n, d) => (d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(1)}%`.padStart(6))
const skillCount = (r) => {
  const sy = r.rp_skillYears ?? {}
  return Object.keys(sy).filter((k) => !k.startsWith('_')).length
}

const cmd = process.argv[2] ?? 'summary'

if (cmd === 'summary') {
  let n = 0, prod = 0, noName = 0, noExp = 0, noSkillYears = 0, noStation = 0, dup = 0
  let oldest = null, newest = null
  for (const r of rows('candidates')) {
    n++
    if (r.data_env === 'prod') prod++
    if (!r.name || r.name === '不明') noName++
    if (r.experience_years == null) noExp++
    if (skillCount(r) === 0) noSkillYears++
    if (!r.rp_nearestStation) noStation++
    if (r.duplicate_flag) dup++
    const d = r.created_at
    if (!oldest || d < oldest) oldest = d
    if (!newest || d > newest) newest = d
  }
  console.log(`控え: ${ARCHIVE_DIR}`)
  console.log(`人材 ${n} 件（prod ${prod}）  ${String(oldest).slice(0, 10)} 〜 ${String(newest).slice(0, 10)}`)
  console.log(`  氏名が不明        ${String(noName).padStart(5)}  ${pct(noName, n)}`)
  console.log(`  経験年数なし      ${String(noExp).padStart(5)}  ${pct(noExp, n)}`)
  console.log(`  スキル年数が空    ${String(noSkillYears).padStart(5)}  ${pct(noSkillYears, n)}`)
  console.log(`  最寄駅なし        ${String(noStation).padStart(5)}  ${pct(noStation, n)}`)
  console.log(`  重複フラグ        ${String(dup).padStart(5)}  ${pct(dup, n)}`)
  let logs = 0
  for (const _ of rows('ai_logs')) logs++
  console.log(`ai_logs ${logs} 件 / 会社 ${[...rows('agent_companies')].length} 社`)
}

if (cmd === 'daily') {
  const byDay = new Map()
  for (const r of rows('candidates')) {
    const d = String(r.created_at).slice(0, 10)
    const a = byDay.get(d) ?? { n: 0, noName: 0, noExp: 0, noSy: 0 }
    a.n++
    if (!r.name || r.name === '不明') a.noName++
    if (r.experience_years == null) a.noExp++
    if (skillCount(r) === 0) a.noSy++
    byDay.set(d, a)
  }
  console.log('日付        件数  氏名不明  経験なし  スキル年数なし')
  for (const [d, a] of [...byDay].sort()) {
    console.log(`${d}  ${String(a.n).padStart(4)}  ${pct(a.noName, a.n)}  ${pct(a.noExp, a.n)}  ${pct(a.noSy, a.n)}`)
  }
}

if (cmd === 'company') {
  const top = Number(process.argv[3] ?? 15)
  const byCo = new Map()
  for (const r of rows('candidates')) {
    const c = (r.from_company ?? '(不明)').trim()
    const a = byCo.get(c) ?? { n: 0, noName: 0, noSy: 0, exp: [] }
    a.n++
    if (!r.name || r.name === '不明') a.noName++
    if (skillCount(r) === 0) a.noSy++
    if (r.experience_years != null) a.exp.push(r.experience_years)
    byCo.set(c, a)
  }
  console.log('件数  氏名不明  スキル年数なし  平均経験  会社')
  for (const [c, a] of [...byCo].sort((x, y) => y[1].n - x[1].n).slice(0, top)) {
    const avg = a.exp.length ? (a.exp.reduce((s, v) => s + v, 0) / a.exp.length).toFixed(1) : '-'
    console.log(`${String(a.n).padStart(4)}  ${pct(a.noName, a.n)}  ${pct(a.noSy, a.n)}  ${String(avg).padStart(6)}年  ${c}`)
  }
}

if (cmd === 'missed') {
  // linked_id が null ＝ 解析したが人材として登録されなかったメール
  const byDomain = new Map()
  let total = 0, missed = 0
  for (const r of rows('ai_logs')) {
    if (r.type !== 'candidate') continue
    total++
    if (r.linked_id) continue
    missed++
    const d = String(r.from_address ?? '').split('@')[1]?.toLowerCase() ?? '(不明)'
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
  }
  console.log(`人材メール ${total} 件中、登録されなかったもの ${missed} 件（${pct(missed, total).trim()}）`)
  console.log('\n件数  送信元ドメイン')
  for (const [d, n] of [...byDomain].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${String(n).padStart(4)}  ${d}`)
  }
}
