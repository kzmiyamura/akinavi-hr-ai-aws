#!/usr/bin/env node
/**
 * 回収したメールが「使える原本」なのか「ゴミ」なのかを判定する。**本番は引かない。**
 *
 *   node scripts/archive_mail_audit.mjs
 *
 * 判定材料はローカルの控えだけ:
 *   - 送信元ドメインが agent_companies（掃除済み223社）にあるか
 *   - 同じ受信時刻・同じ送信元の人材が candidates の控えにあるか（＝実際に登録された）
 *
 * 回収した中身が使い物になるかを、感覚ではなく数で示すためのもの。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIL_DIR = resolve(process.env.AKINAVI_MAIL_DIR ?? 'D:\\akinavi-archive\\mail')
const DB_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? 'D:\\akinavi-archive\\db')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

function* dbRows(table) {
  const dir = join(DB_DIR, table)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

// 掃除済みの派遣・紹介会社ドメイン
const agentDomains = new Set()
for (const a of dbRows('agent_companies')) agentDomains.add(String(a.domain).toLowerCase())

// 登録された人材の「送信元＋受信時刻」。これに当たれば、そのメールは実際に人材になった
const registered = new Map()
for (const c of dbRows('candidates')) {
  const from = String(c.rp_from ?? '').toLowerCase()
  const recv = String(c.rp_received ?? '').slice(0, 16) // 分まで
  if (!from || !recv) continue
  const k = `${from}|${recv}`
  registered.set(k, (registered.get(k) ?? 0) + 1)
}

// 人材の控えが実際に持っている日付。ここに無い日のメールを「登録されなかった」と
// 判定するのは不公平（人材は7日で消えるので、控えを取り始める前の日は端から空）
const covered = new Set()
for (const c of dbRows('candidates')) {
  const d = String(c.rp_received ?? c.created_at ?? '').slice(0, 10)
  if (d) covered.add(d)
}

const stats = { total: 0, byFolder: {}, agent: 0, nonAgent: 0, registered: 0, people: 0, withAtt: 0,
  judgeable: 0, notJudgeable: 0, missed: 0 }
const junkExamples = []
const goodExamples = []
const missedExamples = []

for (const day of readdirSync(MAIL_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
  for (const msg of readdirSync(join(MAIL_DIR, day))) {
    const p = join(MAIL_DIR, day, msg, 'message.json')
    if (!existsSync(p)) continue
    let m
    try { m = readJson(p) } catch { continue }
    stats.total++
    const folder = String(m.folder ?? '').split('\\').pop()
    stats.byFolder[folder] = (stats.byFolder[folder] ?? 0) + 1
    if ((m.attachments ?? []).length > 0) stats.withAtt++

    const from = String(m.from ?? '').toLowerCase()
    const dom = from.split('@')[1] ?? ''
    const isAgent = agentDomains.has(dom)
    if (isAgent) stats.agent++; else stats.nonAgent++

    const recv = String(m.receivedTime ?? '').slice(0, 16)
    const recvDay = String(m.receivedTime ?? '').slice(0, 10)
    const hit = registered.get(`${from}|${recv}`) ?? 0
    if (hit > 0) { stats.registered++; stats.people += hit }

    // 人材の控えがその日を持っているときだけ「登録されたか」を判定する
    const canJudge = covered.has(recvDay)
    if (canJudge) stats.judgeable++; else stats.notJudgeable++

    const row = `${m.receivedTime}  ${folder}  ${dom || '(不明)'}  ${String(m.subject ?? '').slice(0, 55)}`
    if (hit > 0 && goodExamples.length < 5) goodExamples.push(`${row}  → ${hit}人登録`)
    if (canJudge && isAgent && hit === 0) {
      stats.missed++
      if (missedExamples.length < 8) missedExamples.push(row)
    }
    if (!isAgent && hit === 0 && junkExamples.length < 8) junkExamples.push(row)
  }
}

console.log(`回収したメール ${stats.total} 通（添付あり ${stats.withAtt} 通）`)
console.log(`  フォルダ別: ${Object.entries(stats.byFolder).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
console.log('')
console.log(`  送信元が派遣・紹介会社（掃除済み223社）  ${stats.agent} 通`)
console.log(`  それ以外                                ${stats.nonAgent} 通`)
console.log(`  実際に人材として登録された              ${stats.registered} 通（のべ ${stats.people} 人）`)
console.log('')
console.log(`  ※ 人材の控えが持っている日のメール      ${stats.judgeable} 通 ← ここだけが判定可能`)
console.log(`     控えが無い日（判定不能）             ${stats.notJudgeable} 通`)
console.log(`     判定可能な中で「会社からなのに未登録」 ${stats.missed} 通`)
console.log('')
if (missedExamples.length) {
  console.log('=== 取りこぼしの疑い（会社から届いたが人材にならなかった）===')
  for (const x of missedExamples) console.log(`  ${x}`)
  console.log('')
}
if (goodExamples.length) {
  console.log('=== 登録に至ったメール（＝使える原本）===')
  for (const g of goodExamples) console.log(`  ${g}`)
  console.log('')
}
// 「agent_companies に無い」は迷惑メールという意味ではない。
// 会社の行は人材が保存されたときに作られるので、**1人も登録されたことがない会社**は
// 正規の人材紹介会社でもここに出る（2026-09-12 実測: 出てきた8社すべて実在の紹介会社だった）。
console.log('=== 会社の登録も無い送信元（1人も登録されたことがない＝取りこぼしの常連）===')
for (const j of junkExamples) console.log(`  ${j}`)
