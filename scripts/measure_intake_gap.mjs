#!/usr/bin/env node
/**
 * 「届いたメール」と「人材として登録された数」の差を数える。
 *
 * 実測（2026-09-19）: ローカル控えのメールは 9/17 に 3,388通ある一方、
 * DB の人材登録は同日 490人だった。差が何でできているのかを、
 * **推測せずに件名で分類して**数える。
 *
 * ローカル控えだけを使う（本番を引かない＝egress ゼロ）:
 *   D:\akinavi-archive\mail\<日付>\<messageId>\message.json   … 届いたメール
 *   D:\akinavi-archive\db\candidates\<日付>.jsonl              … 登録された人材
 *
 * 突き合わせは from + 件名。1通から複数人が登録される（1メール複数人材・名簿）ので、
 * 「登録された通数」と「登録された人数」を分けて出す。
 *
 *   node scripts/measure_intake_gap.mjs [--day 2026-09-17]
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const DB_ROOT = argOf('--db', 'D:\\akinavi-archive\\db\\candidates')
const DAY = argOf('--day', '2026-09-17')

const norm = (s) => String(s ?? '').replace(/[\s　]/g, '').toLowerCase()
const addrOf = (f) => (typeof f === 'string' ? f : (f?.emailAddress?.address ?? '')).toLowerCase()

// ── 登録された人材（その日の jsonl） ──
const dbFile = path.join(DB_ROOT, `${DAY}.jsonl`)
if (!fs.existsSync(dbFile)) { console.error(`控えがありません: ${dbFile}`); process.exit(1) }
const people = fs.readFileSync(dbFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
/** from+件名 → 登録人数 */
const regBySubj = new Map()
for (const p of people) {
  const k = `${String(p.rp_from ?? '').toLowerCase()}｜${norm(p.rp_subject)}`
  regBySubj.set(k, (regBySubj.get(k) ?? 0) + 1)
}

// ── 届いたメール ──
const dayDir = path.join(MAIL_ROOT, DAY)
if (!fs.existsSync(dayDir)) { console.error(`メール控えがありません: ${dayDir}`); process.exit(1) }

/** 件名からの分類。あくまで件名だけの目安で、本文は見ていない */
const CLASS = [
  ['案件', /案件|募集|求人|人員募集|要員募集|【案件】|お仕事|ご依頼|PJ情報|プロジェクト情報/],
  ['人材', /人材|要員|技術者|エンジニア|営業マン|ご紹介|紹介|スキルシート|経歴書|フリーランス|FL|待機/],
]
const classify = (subj) => CLASS.find(([, re]) => re.test(subj))?.[0] ?? 'その他'

const stat = { total: 0, registered: 0, notRegistered: 0, people: 0 }
const byClass = new Map()
const unregSubjects = new Map()

for (const m of fs.readdirSync(dayDir, { withFileTypes: true })) {
  if (!m.isDirectory()) continue
  const jf = path.join(dayDir, m.name, 'message.json')
  if (!fs.existsSync(jf)) continue
  let j
  try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
  stat.total++
  const subj = String(j.subject ?? '')
  const k = `${addrOf(j.from)}｜${norm(subj)}`
  const n = regBySubj.get(k) ?? 0
  const cls = classify(subj)
  if (!byClass.has(cls)) byClass.set(cls, { mails: 0, regMails: 0, people: 0 })
  const b = byClass.get(cls)
  b.mails++
  if (n > 0) { stat.registered++; stat.people += n; b.regMails++; b.people += n }
  else {
    stat.notRegistered++
    const key = subj.slice(0, 60) || '(件名なし)'
    unregSubjects.set(key, (unregSubjects.get(key) ?? 0) + 1)
  }
}

console.log(`■ ${DAY}`)
console.log(`届いたメール      : ${stat.total}通`)
console.log(`  → 人材が登録された: ${stat.registered}通（${(stat.registered / stat.total * 100).toFixed(1)}%） → ${stat.people}人`)
console.log(`  → 登録ゼロ        : ${stat.notRegistered}通（${(stat.notRegistered / stat.total * 100).toFixed(1)}%）`)
console.log(`DB側の人材（参考） : ${people.length}人\n`)

console.log('件名ざっくり分類   通数   登録された通数   登録人数')
for (const [cls, b] of [...byClass].sort((a, b) => b[1].mails - a[1].mails)) {
  console.log(`  ${cls.padEnd(6)}${String(b.mails).padStart(8)}${String(b.regMails).padStart(14)}${String(b.people).padStart(11)}`)
}

// 同じ件名が何通も届く（複数の宛先・再送）。重複を除いた「別物のメール」の数で見ないと
// 取りこぼしを過大に見積もる。件名が人材らしいものだけに絞って数える
const unregCandidateMails = [...unregSubjects].filter(([s]) => classify(s) === '人材')
const unregCandidateCopies = unregCandidateMails.reduce((a, [, n]) => a + n, 0)
console.log(`\n■ 取りこぼしの実数（件名が「人材」のもの）`)
console.log(`  登録ゼロ: ${unregCandidateCopies}通 / 件名の重複を除くと ${unregCandidateMails.length}通`)
console.log(`  （うち1通しか来ていない＝純粋な取りこぼし候補: ${unregCandidateMails.filter(([, n]) => n === 1).length}通）`)

console.log(`\n■ 登録ゼロだった件名 上位20（同じ件名が何通届いたか）`)
for (const [s, n] of [...unregSubjects].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(4)}通  [${classify(s)}] ${s}`)
}
