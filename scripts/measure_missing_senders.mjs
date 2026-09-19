#!/usr/bin/env node
/**
 * 「人材メールが届いているのに1人も登録されていない」送信元を、送信元ごとに数える。
 *
 * 2026-09-19 実測: 9/17 は 3,388通届いて、件名が人材らしいもの 1,698通のうち
 * 登録できたのは 223通だけだった。**誰が取れていないのか**を先に出す。
 *
 * ローカル控えだけを使う（本番を引かない＝egress ゼロ）:
 *   D:\akinavi-archive\mail\<日付>\<messageId>\message.json
 *   D:\akinavi-archive\db\candidates\<日付>.jsonl
 *
 * 突き合わせは送信元アドレス。件名ではなくアドレスで見るのは、
 * 「この会社からは1人も入っていない」が一番強い手がかりになるため。
 *
 *   node scripts/measure_missing_senders.mjs [--days 2026-09-14,2026-09-18] [--top 40]
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const DB_ROOT = argOf('--db', 'D:\\akinavi-archive\\db\\candidates')
const TOP = Number(argOf('--top', '40'))
/**
 * 送信元ごとの登録人数（本番の実数）。scripts/sql/reg_by_sender.sql の出力を渡す。
 *
 * ⚠ 2026-09-19 の教訓: 既定のローカルDB控え（db\candidates\*.jsonl）は
 * **本番に追いついていない**（9/18 は本番1,452人に対し控え222人＝1,230人欠け）。
 * 控えの欠けをそのまま「取りこぼし」と読むと、桁違いの誤報になる。
 * 登録人数の正は本番の集計。--reg を渡したときはそちらを使う。
 */
const REG_JSON = argOf('--reg', '')

const addrOf = (f) => (typeof f === 'string' ? f : (f?.emailAddress?.address ?? '')).toLowerCase().trim()

/** 件名だけの目安分類。本文は見ていない */
const PROJECT_RE = /案件|募集|求人|人員募集|要員募集|お仕事|ご依頼|PJ情報|プロジェクト情報/
const CAND_RE = /人材|要員|技術者|エンジニア|ご紹介|紹介|スキルシート|経歴書|フリーランス|待機|社員/
const classify = (s) => (PROJECT_RE.test(s) ? '案件' : CAND_RE.test(s) ? '人材' : 'その他')

/** 対象日: メール控えとDB控えの両方がある日だけ（片方しか無い日は比較できない） */
const mailDays = fs.readdirSync(MAIL_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name)
const days = mailDays.filter((d) => fs.existsSync(path.join(DB_ROOT, `${d}.jsonl`)))
  .filter((d) => fs.readdirSync(path.join(MAIL_ROOT, d)).length > 100)   // 取り込みが動いていた日だけ
  .sort()

/** 送信元 → 集計 */
const bySender = new Map()
const get = (a) => {
  if (!bySender.has(a)) bySender.set(a, { mails: 0, cand: 0, proj: 0, other: 0, people: 0, days: new Set(), subjects: new Map() })
  return bySender.get(a)
}

if (REG_JSON) {
  // 本番の集計を正として読む（supabase db query の出力をそのまま渡せる）
  const txt = fs.readFileSync(REG_JSON, 'utf8')
  const rows = JSON.parse(txt.slice(txt.indexOf('{'))).rows
  for (const r of rows) {
    const a = String(r.from_address ?? '').toLowerCase().trim()
    if (a) get(a).people += Number(r.people ?? 0)
  }
  console.log(`登録人数は本番の集計を使用: ${rows.length}送信元 / ${rows.reduce((s, r) => s + Number(r.people ?? 0), 0)}人\n`)
}

for (const day of days) {
  // 登録された人材（送信元ごと）。--reg があるときは本番側で数え済みなので読まない
  if (!REG_JSON) for (const l of fs.readFileSync(path.join(DB_ROOT, `${day}.jsonl`), 'utf8').split('\n')) {
    if (!l) continue
    let p; try { p = JSON.parse(l) } catch { continue }
    const a = String(p.rp_from ?? '').toLowerCase().trim()
    if (a) get(a).people++
  }
  // 届いたメール（送信元ごと）
  const dayDir = path.join(MAIL_ROOT, day)
  for (const m of fs.readdirSync(dayDir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const jf = path.join(dayDir, m.name, 'message.json')
    if (!fs.existsSync(jf)) continue
    let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const a = addrOf(j.from)
    if (!a) continue
    const e = get(a)
    const subj = String(j.subject ?? '')
    const cls = classify(subj)
    e.mails++
    e.days.add(day)
    if (cls === '人材') { e.cand++; e.subjects.set(subj.slice(0, 70), (e.subjects.get(subj.slice(0, 70)) ?? 0) + 1) }
    else if (cls === '案件') e.proj++
    else e.other++
  }
}

const rows = [...bySender].map(([addr, e]) => ({
  addr, domain: addr.split('@')[1] ?? '', ...e,
  days: e.days.size,
  uniqSubjects: e.subjects.size,
}))

const totCand = rows.reduce((a, r) => a + r.cand, 0)
const totPeople = rows.reduce((a, r) => a + r.people, 0)
console.log(`対象日: ${days.length}日 (${days[0]} 〜 ${days[days.length - 1]})`)
console.log(`件名が人材のメール ${totCand}通 / 登録された人材 ${totPeople}人\n`)

// ① 人材メールを送ってきているのに1人も登録されていない送信元
const zero = rows.filter((r) => r.cand > 0 && r.people === 0).sort((a, b) => b.cand - a.cand)
const zeroMails = zero.reduce((a, r) => a + r.cand, 0)
console.log(`■ 人材メールを送っているのに登録ゼロの送信元: ${zero.length}件 / 人材メール ${zeroMails}通`)
console.log(`   (人材メール全体の ${(zeroMails / totCand * 100).toFixed(1)}%)\n`)
console.log('   人材通  別件名  日数  送信元')
for (const r of zero.slice(0, TOP)) {
  console.log(`   ${String(r.cand).padStart(6)}  ${String(r.uniqSubjects).padStart(6)}  ${String(r.days).padStart(4)}  ${r.addr}`)
}

// ② 一部しか取れていない送信元（人材メール数 >> 登録人数）
const partial = rows.filter((r) => r.cand >= 10 && r.people > 0)
  .map((r) => ({ ...r, gap: r.cand - r.people }))
  .sort((a, b) => b.gap - a.gap)
console.log(`\n■ 届いているのに大半が取れていない送信元（人材メール10通以上）`)
console.log('   人材通  登録人数   差  送信元')
for (const r of partial.slice(0, TOP)) {
  console.log(`   ${String(r.cand).padStart(6)}  ${String(r.people).padStart(8)}  ${String(r.gap).padStart(4)}  ${r.addr}`)
}

// ③ ドメイン単位（担当者ごとにアドレスが分かれる会社をまとめる）
const byDom = new Map()
for (const r of rows) {
  if (!byDom.has(r.domain)) byDom.set(r.domain, { cand: 0, people: 0, addrs: 0 })
  const d = byDom.get(r.domain)
  d.cand += r.cand; d.people += r.people; d.addrs++
}
const domRows = [...byDom].map(([domain, d]) => ({ domain, ...d, gap: d.cand - d.people }))
  .filter((d) => d.cand >= 10).sort((a, b) => b.gap - a.gap)
console.log(`\n■ ドメイン単位（人材メール10通以上・差の大きい順）`)
console.log('   人材通  登録人数   差  アドレス数  ドメイン')
for (const d of domRows.slice(0, TOP)) {
  console.log(`   ${String(d.cand).padStart(6)}  ${String(d.people).padStart(8)}  ${String(d.gap).padStart(4)}  ${String(d.addrs).padStart(8)}  ${d.domain}`)
}
