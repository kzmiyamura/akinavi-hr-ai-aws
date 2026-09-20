#!/usr/bin/env node
/**
 * 市況レポート（スキル別の単価相場と供給量）と BP レポート（取引先ごとの通信簿）。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * SES の「市況分析」＝このスキルは今いくらで、何人動いているか。
 * SES の「BP分析」  ＝どの取引先から来た人材が使えるか。
 *
 * どちらも新しいデータは要らない。既に持っている
 *   desired_rate / skills / experience_years / rp_from / rp_commercialFlow
 * を束ねるだけで出る。
 *
 *   node scripts/market_report.mjs [--min 20] [--top 25]
 */
import { loadRows } from './role_classifier/dataset.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MIN = Number(argOf('--min', '20'))   // この人数未満のスキルは相場と言えないので出さない
const TOP = Number(argOf('--top', '25'))

/** 「55～60万」「75万円」→ 万円（範囲は中央値）。取れなければ null */
function parseRate(s) {
  const nums = [...String(s ?? '').matchAll(/(\d{2,3})\s*万/g)].map((m) => Number(m[1]))
    .filter((n) => n >= 20 && n <= 300)
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}
const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const pct = (a, p) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

const rows = loadRows()

// ── 市況: スキル別の単価相場 ─────────────────────────────────────────────
const bySkill = new Map()
for (const r of rows) {
  const rate = parseRate(r.desired_rate)
  if (rate == null) continue
  const exp = Number(r.experience_years ?? 0) || null
  for (const s of (Array.isArray(r.skills) ? r.skills : [])) {
    const k = String(s ?? '').trim()
    if (!k) continue
    if (!bySkill.has(k)) bySkill.set(k, { rates: [], exps: [] })
    bySkill.get(k).rates.push(rate)
    if (exp) bySkill.get(k).exps.push(exp)
  }
}
const all = rows.map((r) => parseRate(r.desired_rate)).filter((v) => v != null)
console.log(`■ 市況: 全体の希望単価  中央値 ${median(all)}万 / 下位25% ${pct(all, 0.25)}万 / 上位25% ${pct(all, 0.75)}万（${all.length}人）\n`)

const skillRows = [...bySkill].filter(([, v]) => v.rates.length >= MIN)
  .map(([k, v]) => ({
    skill: k, n: v.rates.length, med: median(v.rates),
    p25: pct(v.rates, 0.25), p75: pct(v.rates, 0.75), exp: median(v.exps),
  }))

console.log(`■ 単価が高いスキル（${MIN}人以上・中央値の高い順 上位${TOP}）`)
console.log('   人数   中央値   下位25%〜上位25%   経験中央値  スキル')
for (const s of [...skillRows].sort((a, b) => b.med - a.med).slice(0, TOP)) {
  console.log(`   ${String(s.n).padStart(4)}  ${String(s.med).padStart(5)}万   ${String(s.p25).padStart(3)}〜${String(s.p75).padStart(3)}万        ` +
    `${String(s.exp ?? '-').padStart(4)}年   ${s.skill}`)
}

console.log(`\n■ 供給が多いスキル（人数の多い順 上位${TOP}）＝ 競合が多い`)
console.log('   人数   中央値   スキル')
for (const s of [...skillRows].sort((a, b) => b.n - a.n).slice(0, TOP)) {
  console.log(`   ${String(s.n).padStart(4)}  ${String(s.med).padStart(5)}万   ${s.skill}`)
}

// ── 商流による単価差（自社 / N社先） ─────────────────────────────────────
const byFlow = new Map()
for (const r of rows) {
  const rate = parseRate(r.desired_rate)
  if (rate == null) continue
  const f = String(r.rp_commercialFlow ?? '不明')
  if (!byFlow.has(f)) byFlow.set(f, [])
  byFlow.get(f).push(rate)
}
console.log('\n■ 商流別の単価（間に会社が挟まるほど本人の手取りは下がる）')
for (const [f, v] of [...byFlow].filter(([, v]) => v.length >= 10).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`   ${f.padEnd(8)} ${String(v.length).padStart(5)}人  中央値 ${median(v)}万`)
}

// ── BP分析: 取引先ごとの通信簿 ───────────────────────────────────────────
const byBp = new Map()
for (const r of rows) {
  const dom = String(r.rp_from ?? '').split('@')[1]?.toLowerCase()
  if (!dom) continue
  if (!byBp.has(dom)) byBp.set(dom, { n: 0, rates: [], exps: [], ages: [], withAttach: 0, flows: new Map() })
  const b = byBp.get(dom)
  b.n++
  const rate = parseRate(r.desired_rate)
  if (rate != null) b.rates.push(rate)
  const e = Number(r.experience_years ?? 0); if (e) b.exps.push(e)
  const a = Number(r.rp_age ?? 0); if (a) b.ages.push(a)
  if (/\.(xlsx?|xlsm|docx?|pdf)($|\?)/i.test(String(r.resume_url ?? ''))) b.withAttach++
  const f = String(r.rp_commercialFlow ?? '不明')
  b.flows.set(f, (b.flows.get(f) ?? 0) + 1)
}
const bpRows = [...byBp].filter(([, v]) => v.n >= MIN)
  .map(([dom, v]) => ({
    dom, n: v.n, med: median(v.rates), exp: median(v.exps), age: median(v.ages),
    attachPct: v.withAttach / v.n * 100,
    ownPct: (v.flows.get('自社') ?? 0) / v.n * 100,
  }))

console.log(`\n■ BP分析: 取引先ごとの通信簿（${MIN}人以上 上位${TOP}）`)
console.log('   人数  単価中央値  経験  年齢  経歴書添付率  自社比率  ドメイン')
for (const b of bpRows.sort((a, b2) => b2.n - a.n).slice(0, TOP)) {
  console.log(`   ${String(b.n).padStart(4)}   ${String(b.med ?? '-').padStart(5)}万   ${String(b.exp ?? '-').padStart(3)}年 ${String(b.age ?? '-').padStart(3)}歳  ` +
    `${b.attachPct.toFixed(0).padStart(5)}%     ${b.ownPct.toFixed(0).padStart(4)}%   ${b.dom}`)
}
console.log(`
※ 本来この表には「提案数」「面談通過率」「成約率」が要る。
   submissions は直近7日で9件しかない（auto_match_enabled=false で止まっているため）。
   そこが埋まるまで、BP分析は「どんな人材を送ってくるか」までしか言えない。`)
