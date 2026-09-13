#!/usr/bin/env node
/**
 * 「人が読めばこうなる」をローカルで作り、DBの実際の値と突き合わせる。
 *
 *   node scripts/quality_truth.mjs [--limit 20] [--model haiku]
 *
 * ■ なぜ必要か
 *   品質チェックSQL（scripts/sql/quality_check.sql）で分かるのは
 *   「経験年数が null の人が110人いる」までで、**入っている値が正しいか**は分からない。
 *   本番と同じ抽出関数（_extractors.gen.mjs）で期待値を作っても、
 *   **同じ答えしか出ない**ので抽出ミスは永久に見つからない（自分の答案を自分で採点する形）。
 *   そこで独立した採点者として claude -p にメール原文を読ませ、正解を作る。
 *
 * ■ 通信
 *   メール原本は D:\akinavi-archive\mail（Outlook から回収済み）。
 *   DBの実際の値も D:\akinavi-archive\db（増分控え）。
 *   **突き合わせは完全にローカルで、egress はゼロ。** claude -p も Max 枠なので課金ゼロ。
 *
 * ■ 判定する項目
 *   メール本文だけで人が判断できるものに限る。経歴書（添付）の中身が要るもの
 *   （スキル年数・案件履歴）は別の仕組みが要るので、ここでは扱わない。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callModel } from './llm_extract/caller.mjs'

const MAIL_DIR = resolve(process.env.AKINAVI_MAIL_DIR ?? 'D:\\akinavi-archive\\mail')
const DB_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? 'D:\\akinavi-archive\\db')
const OUT_DIR = resolve(process.env.AKINAVI_TRUTH_DIR ?? 'D:\\akinavi-archive\\truth')

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const LIMIT = Number(flag('limit', 10))
const MODEL = flag('model', 'haiku')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

/** Outlook はローカル時刻、DB(Graph) は UTC。突き合わせる前に必ず UTC に揃える */
function utcMinute(s) {
  if (!s) return null
  const d = new Date(String(s))
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 16)
}

function* dbRows(table) {
  const dir = join(DB_DIR, table)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

// DB の実際の値（送信元＋受信時刻で引けるようにする）
const actual = new Map()
for (const c of dbRows('candidates')) {
  const k = `${String(c.rp_from ?? '').toLowerCase()}|${utcMinute(c.rp_received)}`
  if (!actual.has(k)) actual.set(k, [])
  actual.get(k).push(c)
}

// 原本のうち、DBに登録された人がいるものだけを採点対象にする
const targets = []
for (const day of readdirSync(MAIL_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
  for (const msg of readdirSync(join(MAIL_DIR, day))) {
    const p = join(MAIL_DIR, day, msg, 'message.json')
    if (!existsSync(p)) continue
    let m
    try { m = readJson(p) } catch { continue }
    const k = `${String(m.from ?? '').toLowerCase()}|${utcMinute(m.receivedTimeUtc ?? m.receivedTime)}`
    const rows = actual.get(k)
    if (!rows || rows.length !== 1) continue   // 複数人メールは対応付けが曖昧なので外す
    targets.push({ mail: m, row: rows[0] })
    if (targets.length >= LIMIT) break
  }
  if (targets.length >= LIMIT) break
}

if (targets.length === 0) {
  console.error('採点できる組み合わせがありません（原本とDB行が1対1で対応するものが無い）')
  console.error('回収が進むと増えます。まず scripts/outlook_export.ps1 と archive_local.mjs を回してください')
  process.exit(1)
}

const PROMPT = (m) => `あなたは人材紹介メールを読む採用担当です。
下のメールから、**本文に明示されている場合のみ**次の項目を JSON で出してください。
書かれていない・読み取れない項目は null にしてください。推測で埋めないこと。

- name: 技術者の氏名やイニシャル（例 "A.S" "田中" "KT"）
- experienceYears: IT経験年数（数値。「10年」なら 10。複数の年数が書かれていても合計しない）
- desiredRate: 希望単価（原文のまま。例 "70万" "60〜65万"）
- nearestStation: 最寄駅（駅名のみ。「〇〇駅」の駅は付けない）
- nationality: 国籍（日本人なら "日本"）
- age: 年齢（数値）
- gender: "男性" か "女性"

JSON のみを出力し、説明文は書かないでください。

件名: ${m.subject ?? ''}
差出人: ${m.from ?? ''}
本文:
${String(m.body ?? '').slice(0, 4000)}`

mkdirSync(OUT_DIR, { recursive: true })

const FIELDS = [
  ['name', (r) => r.name],
  ['experienceYears', (r) => r.experience_years],
  ['desiredRate', (r) => r.desired_rate],
  ['nearestStation', (r) => r.rp_nearestStation],
  ['nationality', (r) => r.rp_nationality],
  ['age', (r) => r.rp_age],
  ['gender', (r) => r.rp_gender],
]

/** 比べる前に表記を揃える。全角/半角・空白・「駅」「歳」「円」の有無で不一致にしない */
function norm(v) {
  if (v === null || v === undefined || v === '') return null
  let s = String(v).trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .replace(/駅$/, '')
    .replace(/[歳才]$/, '')
    .toLowerCase()
  if (/^\d+$/.test(s)) s = String(Number(s))
  return s || null
}

const stats = new Map(FIELDS.map(([f]) => [f, { ok: 0, ng: 0, dbNull: 0, truthNull: 0 }]))
const mismatches = []
let totalCost = 0

for (const [i, t] of targets.entries()) {
  process.stdout.write(`\r採点中 ${i + 1}/${targets.length}…`)
  let truth
  try {
    // callModel は { data, costUsd, ms, raw } を返す。data は parseJsonLoose 済み
    const res = await callModel(MODEL, PROMPT(t.mail))
    truth = res?.data
    if (!truth || typeof truth !== 'object') throw new Error(`JSONとして読めない: ${String(res?.raw ?? '').slice(0, 120)}`)
    totalCost += res.costUsd ?? 0
  } catch (e) {
    console.log(`\n  ${t.row.name}: 採点失敗 ${String(e).slice(0, 120)}`)
    continue
  }
  writeFileSync(join(OUT_DIR, `${t.row.id}.json`),
    JSON.stringify({ expected: truth, actual: Object.fromEntries(FIELDS.map(([f, g]) => [f, g(t.row)])) }, null, 2), 'utf8')

  for (const [field, get] of FIELDS) {
    const exp = norm(truth[field])
    const act = norm(get(t.row))
    const s = stats.get(field)
    if (exp === null) { s.truthNull++; continue }      // 本文に書いていない＝採点対象外
    if (act === null) { s.dbNull++; mismatches.push(`${field}: 本文「${truth[field]}」→ DBは空  (${t.row.name})`); continue }
    if (exp === act) s.ok++
    else { s.ng++; mismatches.push(`${field}: 本文「${truth[field]}」→ DBは「${get(t.row)}」  (${t.row.name})`) }
  }
}

console.log(`\n\n採点 ${targets.length} 通（原本とDB行が1対1のものだけ）\n`)
console.log('項目              一致  不一致  DBが空  本文に記載なし  正答率')
for (const [field, s] of stats) {
  const judged = s.ok + s.ng + s.dbNull
  const rate = judged === 0 ? '-' : `${((s.ok / judged) * 100).toFixed(0)}%`
  console.log(`${field.padEnd(17)}${String(s.ok).padStart(4)}${String(s.ng).padStart(7)}${String(s.dbNull).padStart(8)}${String(s.truthNull).padStart(15)}${rate.padStart(8)}`)
}
if (mismatches.length) {
  console.log('\n=== 食い違い（本文にはあるのにDBが違う/空）===')
  for (const m of mismatches.slice(0, 25)) console.log(`  ${m}`)
  if (mismatches.length > 25) console.log(`  …他 ${mismatches.length - 25} 件`)
}
console.log(`\n採点結果: ${OUT_DIR}`)
// Max 枠で回しているので実課金ではない。1通あたりの重さの目安として出す
console.log(`採点にかかった量: $${totalCost.toFixed(4)}（Max枠なので実課金ではない）`)
