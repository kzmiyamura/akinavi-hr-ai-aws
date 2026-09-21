#!/usr/bin/env node
/**
 * 需要（案件メール）と供給（人材）を突き合わせて、市況を出す。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * 動機（2026-09-21 ユーザー「巷の案件情報や人材情報を見てアプリを強化できないか」）:
 *   外を見に行く前に、**自分たちが捨てているもの**を測る。
 *   案件メールは inbound_project_enabled=false のため保存されず、
 *   直近7日で 7,546通が PROJECT_INBOUND_DISABLED で消えている（ai_logs 実測）。
 *   中身には 必須スキル・単価・勤務地・商流・募集人数 が入っており、
 *   これは**買えば金がかかる需要側の市況データ**そのもの。
 *
 * 供給側（人材）は既に持っている。両方そろうと言えるようになること:
 *   ・需給ギャップ  … 案件は多いのに人材が少ないスキル＝取りに行く価値がある
 *   ・単価の需給差  … 案件が出す単価と人材が希望する単価の開き
 *   ・空振りの理由  … 案件が求めるのに誰も持っていないスキル
 *
 *   node scripts/measure_supply_demand.mjs [--top 25]
 */
import fs from 'fs'
import path from 'path'
import { loadRows } from './role_classifier/dataset.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const TOP = Number(argOf('--top', '25'))
const SRC = 'supabase/functions/poll-email/index.ts'

// ── 本番の振り分けをそのまま使って「案件メール」を選ぶ ──────────────────
function loadPreFilter() {
  const src = fs.readFileSync(SRC, 'utf8')
  const start = src.indexOf('const SKIP_SUBJECT_PATTERNS = [')
  const endStart = src.indexOf('\nfunction preFilterEmail(')
  const after = src.slice(endStart + 1)
  const region = src.slice(start, endStart + 1 + after.indexOf('\n}\n') + 3)
  const js = region
    .replace(/:\s*'skip'\s*\|\s*'candidate'\s*\|\s*'project'\s*\|\s*'unknown'/g, '')
    .replace(/:\s*GraphMessage/g, '').replace(/:\s*string(\[\])?/g, '')
    .replace(/:\s*boolean/g, '').replace(/\bexport\s+/g, '')
  return new Function(`${js}\nreturn preFilterEmail`)()
}
const preFilterEmail = loadPreFilter()

const decode = (t) => String(t)
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const bodyOf = (m) => {
  const raw = typeof m.body === 'string' ? m.body : (m.body?.content ?? '')
  const isHtml = typeof m.body === 'string'
    ? /<(?:html|body|div|br|p)\b/i.test(raw)
    : (m.body?.contentType ?? '').toLowerCase() === 'html'
  return decode(isHtml ? raw.replace(/<[^>]+>/g, ' ') : raw)
}

/** 単価。全角数字にも対応（実データにある） */
function parseRate(s) {
  const t = String(s ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  const nums = [...t.matchAll(/(\d{2,3})\s*万/g)].map((m) => Number(m[1])).filter((n) => n >= 20 && n <= 300)
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}
const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// ── 供給側: 人材のスキルと希望単価 ─────────────────────────────────────
const people = loadRows()
const supply = new Map()   // スキル → 希望単価の配列
for (const r of people) {
  const rate = parseRate(r.desired_rate)
  for (const s of (Array.isArray(r.skills) ? r.skills : [])) {
    const k = String(s ?? '').trim()
    if (!k) continue
    if (!supply.has(k)) supply.set(k, [])
    if (rate != null) supply.get(k).push(rate)
    else supply.get(k).push(NaN)   // 人数は数えたいので枠だけ入れる
  }
}
const supplyCount = (k) => supply.get(k)?.length ?? 0
const supplyRate = (k) => median((supply.get(k) ?? []).filter(Number.isFinite))

// ── 需要側: 案件メールから単価とスキルを拾う ──────────────────────────
// スキル名は人材側で実際に使われている語彙をそのまま使う（skill_master 由来なので
// 表記ゆれが吸収済み）。案件本文にその語が語として出てくるかを見る。
const SKILLS = [...supply.keys()].filter((k) => supplyCount(k) >= 20 && k.length >= 2)
const wordRe = (s) => new RegExp(`(^|[^A-Za-z0-9#+])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9#+]|$)`, 'i')
const RE = new Map(SKILLS.map((s) => [s, wordRe(s)]))

const days = fs.readdirSync(MAIL_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => fs.readdirSync(path.join(MAIL_ROOT, d.name)).length > 100)
  .map((d) => d.name).sort()

const demand = new Map()   // スキル → 案件単価の配列
let projectMails = 0, scanned = 0
for (const day of days) {
  const dayDir = path.join(MAIL_ROOT, day)
  for (const m of fs.readdirSync(dayDir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const jf = path.join(dayDir, m.name, 'message.json')
    if (!fs.existsSync(jf)) continue
    let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    scanned++
    const subject = String(j.subject ?? '')
    const raw = typeof j.body === 'string' ? j.body : (j.body?.content ?? '')
    if (preFilterEmail({ subject, body: { content: raw } }, true) !== 'project') continue
    projectMails++
    // ⚠ URL を外してから当てること。最初これを忘れて HTTPS が4,868案件で1位になった
    //   （本文の https:// に当たっていただけ）。S3・EC2・VB・Teams も同様に汚染される。
    //   inbound-email の stripUrlsForSkillMatching と同じ考え方。
    const text = `${subject}\n${bodyOf(j)}`.replace(/https?:\/\/\S+/g, ' ').replace(/\S+@\S+\.\S+/g, ' ')
    const rate = parseRate(text.slice(0, 1500))   // 案件の単価は冒頭に書かれる
    for (const [s, re] of RE) {
      if (!re.test(text)) continue
      if (!demand.has(s)) demand.set(s, [])
      demand.get(s).push(rate ?? NaN)
    }
  }
}

console.log(`走査 ${scanned}通 / そのうち案件メール ${projectMails}通（${days.length}日分）`)
console.log(`供給側の人材 ${people.length}人\n`)

const rows = SKILLS.map((s) => {
  const dN = demand.get(s)?.length ?? 0
  const sN = supplyCount(s)
  return {
    skill: s, demand: dN, supply: sN,
    ratio: sN > 0 ? dN / sN : null,
    dRate: median((demand.get(s) ?? []).filter(Number.isFinite)),
    sRate: supplyRate(s),
  }
}).filter((r) => r.demand >= 20 && r.supply >= 20)

console.log(`■ 人材が足りていないスキル（案件÷人材 の高い順・上位${TOP}）`)
console.log('   案件数  人材数   倍率   案件単価  人材希望  差    スキル')
for (const r of [...rows].sort((a, b) => b.ratio - a.ratio).slice(0, TOP)) {
  const diff = r.dRate != null && r.sRate != null ? (r.dRate - r.sRate).toFixed(0) : '-'
  console.log(`   ${String(r.demand).padStart(5)}  ${String(r.supply).padStart(5)}  ${r.ratio.toFixed(2).padStart(5)}  ` +
    `${String(r.dRate ?? '-').padStart(6)}万  ${String(r.sRate ?? '-').padStart(6)}万  ${String(diff).padStart(4)}  ${r.skill}`)
}

console.log(`\n■ 人材が余っているスキル（倍率の低い順・上位${TOP}）＝ 競合が多い`)
console.log('   案件数  人材数   倍率   案件単価  人材希望  スキル')
for (const r of [...rows].sort((a, b) => a.ratio - b.ratio).slice(0, TOP)) {
  console.log(`   ${String(r.demand).padStart(5)}  ${String(r.supply).padStart(5)}  ${r.ratio.toFixed(2).padStart(5)}  ` +
    `${String(r.dRate ?? '-').padStart(6)}万  ${String(r.sRate ?? '-').padStart(6)}万  ${r.skill}`)
}

const gap = rows.filter((r) => r.dRate != null && r.sRate != null)
  .sort((a, b) => (b.dRate - b.sRate) - (a.dRate - a.sRate))
console.log(`\n■ 案件の方が高く出しているスキル（差の大きい順・上位12）＝ 単価を上げられる`)
for (const r of gap.slice(0, 12)) {
  console.log(`   案件${String(r.dRate).padStart(3)}万 − 人材希望${String(r.sRate).padStart(3)}万 = +${(r.dRate - r.sRate).toFixed(0)}万   ${r.skill}（案件${r.demand}/人材${r.supply}）`)
}
