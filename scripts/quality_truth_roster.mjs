#!/usr/bin/env node
/**
 * 名簿（1通に複数人）の品質を測る。
 *
 *   node scripts/quality_truth_roster.mjs [--limit 10] [--model haiku]
 *
 * ■ なぜ別に要るか（2026-09-17 ユーザー指摘「名簿系はあった？」）
 *   quality_truth.mjs は `personCount !== 1` のメールを**スキップ**している
 *   （1通に複数人いると、どの人とDB行が対応するか決められないため）。
 *   つまり名簿は一度も採点されていなかった。
 *   ところが prod 実測で **名簿由来の人材は 1,485人＝全体の 50.6%**。
 *   品質測定が人材の半分を見ていなかった。
 *
 * ■ 名簿で壊れるのは「項目の値」より先に「人の数」
 *   ・名簿の行を取り逃す → その人が丸ごと登録されない
 *   ・名簿でない表を名簿と誤認 → 実在しない人材が量産される（過去に駅名人材11件）
 *   ・兄弟ブロックの値の混入 → 全員が同じ単価・同じ駅になる
 *   そこでこのスクリプトは **人数・落ちた人・幽霊** を先に測り、
 *   名前で対応が付いた人だけ項目を採点する。
 *
 * ■ 通信
 *   メール原本もDBの控えもローカル（D:\akinavi-archive）。**egress ゼロ**。
 *   claude -p も Max 枠。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callModel } from './llm_extract/caller.mjs'

const MAIL_DIR = resolve(process.env.AKINAVI_MAIL_DIR ?? 'D:\\akinavi-archive\\mail')
const DB_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? 'D:\\akinavi-archive\\db')
const OUT_DIR = resolve(process.env.AKINAVI_TRUTH_DIR ?? 'D:\\akinavi-archive\\truth-roster')

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

/** 氏名の比較。表記ゆれ（記号・空白・全半角）を吸収する。
 *  イニシャルは「M.Y」「M・Y」「MY」「Ｍ．Ｙ」等で揺れるので、記号を全部落として比べる */
const nameKey = (s) => String(s ?? '')
  .replace(/[\s　.・,，、\-‐―ー_]/g, '')
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .toLowerCase()

// ── 突き合わせの鍵を作る ────────────────────────────────────────────────────
const actual = new Map()
for (const c of dbRows('candidates')) {
  const k = `${String(c.rp_from ?? '').toLowerCase()}|${utcMinute(c.rp_received)}`
  if (!actual.has(k)) actual.set(k, [])
  actual.get(k).push(c)
}

const mailsByKey = new Map()
for (const day of readdirSync(MAIL_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
  for (const msg of readdirSync(join(MAIL_DIR, day))) {
    const p = join(MAIL_DIR, day, msg, 'message.json')
    if (!existsSync(p)) continue
    let m
    try { m = readJson(p) } catch { continue }
    const k = `${String(m.from ?? '').toLowerCase()}|${utcMinute(m.receivedTimeUtc ?? m.receivedTime)}`
    if (!mailsByKey.has(k)) mailsByKey.set(k, [])
    mailsByKey.get(k).push(m)
  }
}

// 名簿として採点できるのは「メール1通 ↔ 人材2行以上」が確実に言える組み合わせ
const targets = []
for (const [k, mails] of mailsByKey) {
  if (mails.length !== 1) continue            // 同じ分に複数通 → どの人がどのメールか決められない
  const rows = actual.get(k)
  if (!rows || rows.length < 2) continue      // 1人以下 → quality_truth.mjs の担当
  targets.push({ mail: mails[0], rows })
  if (targets.length >= LIMIT) break
}

if (targets.length === 0) {
  console.log('採点できる名簿がありません（1通 ↔ 2人以上 で対応が付くものが無い）')
  console.log('回収が進むと増えます。0 が続くようなら outlook_export.ps1 / archive_local.mjs を確認すること')
  process.exit(0)
}

const PROMPT = (m) => `あなたは人材紹介メールを読む採用担当です。
下のメールには**複数の技術者**が載っています。**本文に明示されている人だけ**を、
上から順に JSON で列挙してください。推測で人を増やさないでください。

⚠ 次のものは技術者ではありません。people に入れないでください:
  ・案件（仕事）の説明。募集要項・必須スキル・単価だけが書かれた塊
  ・「他にも多数おります」等の営業文
  ・スキル一覧表や工程表の見出し・行ラベル
  ・送信元の営業担当者（署名の人）

各人について、**書かれている場合のみ**値を入れ、書いていなければ null にしてください。
- name: 氏名やイニシャル（例 "A.S" "田中" "KT"）。本文の表記そのまま
- age: 年齢（数値）
- gender: "男性" か "女性"
- desiredRate: 希望単価（原文のまま。例 "70万" "60〜65万"）
- nearestStation: 最寄駅（駅名のみ。「〇〇駅」の駅は付けない）

JSON のみを出力し、説明文は書かないでください。
{"personCount": 3, "people": [{"name":"","age":null,"gender":null,"desiredRate":null,"nearestStation":null}]}

件名: ${m.subject ?? ''}
差出人: ${m.from ?? ''}
本文:
${String(m.body ?? '').slice(0, 12000)}`

mkdirSync(OUT_DIR, { recursive: true })

const FIELDS = [
  ['age', (r) => r.rp_age],
  ['gender', (r) => r.rp_gender],
  ['desiredRate', (r) => r.desired_rate],
  ['nearestStation', (r) => r.rp_nearestStation],
]

function norm(field, v) {
  if (v === null || v === undefined) return null
  let s = String(v).trim()
  if (!s) return null
  if (field === 'gender') s = s.replace(/性$/, '')
  if (field === 'age') s = s.replace(/[歳才]$/, '')
  if (field === 'nearestStation') s = s.replace(/駅$/, '').replace(/^(JR|ＪＲ)/, '')
  if (field === 'desiredRate') {
    const m = s.match(/(\d{2,3})万/)
    if (m) return `${Number(m[1])}万`
  }
  if (/^\d+$/.test(s)) s = String(Number(s))
  return s || null
}

// ── 採点 ────────────────────────────────────────────────────────────────────
let mails = 0, cost = 0
let countOk = 0, countNg = 0
let missing = 0, phantom = 0, matched = 0, dbTotal = 0, truthTotal = 0
const stats = new Map(FIELDS.map(([f]) => [f, { ok: 0, ng: 0, dbNull: 0, truthNull: 0 }]))
const notes = []

for (const [i, t] of targets.entries()) {
  process.stdout.write(`\r採点中 ${i + 1}/${targets.length}…`)
  let truth
  try {
    const res = await callModel(MODEL, PROMPT(t.mail))
    truth = res?.data
    if (!truth || !Array.isArray(truth.people)) throw new Error('people 配列が無い')
    cost += res.costUsd ?? 0
  } catch (e) {
    console.log(`\n  ${String(t.mail.subject).slice(0, 40)}: 採点失敗 ${String(e).slice(0, 100)}`)
    continue
  }
  mails++

  const truthPeople = truth.people.filter((p) => p && p.name)
  const dbNames = new Map(t.rows.map((r) => [nameKey(r.name), r]))
  const truthNames = new Set(truthPeople.map((p) => nameKey(p.name)))
  truthTotal += truthPeople.length
  dbTotal += t.rows.length

  if (truthPeople.length === t.rows.length) countOk++
  else {
    countNg++
    notes.push(`人数: 本文${truthPeople.length}人 → DB${t.rows.length}人  「${String(t.mail.subject).slice(0, 44)}」`)
  }

  // 本文にいるのに DB に無い＝落ちた人 / DB にいるのに本文に無い＝幽霊
  for (const p of truthPeople) {
    if (!dbNames.has(nameKey(p.name))) {
      missing++
      notes.push(`  落ちた: 「${p.name}」 ← ${String(t.mail.subject).slice(0, 40)}`)
    }
  }
  for (const r of t.rows) {
    if (!truthNames.has(nameKey(r.name))) {
      phantom++
      notes.push(`  幽霊  : 「${r.name}」 ← ${String(t.mail.subject).slice(0, 40)}`)
    }
  }

  // 名前で対応が付いた人だけ項目を採点する
  for (const p of truthPeople) {
    const row = dbNames.get(nameKey(p.name))
    if (!row) continue
    matched++
    for (const [field, get] of FIELDS) {
      const s = stats.get(field)
      const exp = norm(field, p[field])
      const act = norm(field, get(row))
      if (exp === null) { s.truthNull++; continue }
      if (act === null) { s.dbNull++; notes.push(`  ${field}: 本文「${p[field]}」→ DBは空  (${row.name})`); continue }
      if (exp === act) s.ok++
      else { s.ng++; notes.push(`  ${field}: 本文「${p[field]}」→ DBは「${get(row)}」  (${row.name})`) }
    }
  }

  writeFileSync(join(OUT_DIR, `${encodeURIComponent(String(t.mail.subject ?? 'x')).slice(0, 80)}.json`),
    JSON.stringify({ subject: t.mail.subject, expected: truth, actual: t.rows.map((r) => ({
      name: r.name, ...Object.fromEntries(FIELDS.map(([f, g]) => [f, g(r)])) })) }, null, 2), 'utf8')
}

console.log(`\n\n採点 ${mails} 名簿（メール1通 ↔ DB2人以上で対応が付いたもの）`)
console.log(`  本文の人数 合計 ${truthTotal} / DBの人数 合計 ${dbTotal}\n`)
console.log('■ 名簿として正しく割れているか')
console.log(`  人数が一致        ${countOk} / ${countOk + countNg}`)
console.log(`  ★落ちた人（本文にいるのにDBに無い）  ${missing}`)
console.log(`  ★幽霊  （DBにいるのに本文に無い）    ${phantom}`)
console.log(`  名前で対応が付いた人              ${matched}\n`)
console.log('■ 対応が付いた人の項目')
console.log('項目              一致  不一致  DBが空  本文に記載なし  正答率')
for (const [f, s] of stats) {
  const d = s.ok + s.ng + s.dbNull
  const pct = d ? `${Math.round((s.ok / d) * 100)}%` : '—'
  console.log(`${f.padEnd(16)}${String(s.ok).padStart(4)}${String(s.ng).padStart(7)}${String(s.dbNull).padStart(8)}${String(s.truthNull).padStart(15)}${pct.padStart(8)}`)
}
if (notes.length) {
  console.log('\n=== 内訳 ===')
  for (const n of notes.slice(0, 40)) console.log('  ' + n)
  if (notes.length > 40) console.log(`  …ほか ${notes.length - 40} 件`)
}

const h = join(OUT_DIR, '_history.csv')
if (!existsSync(h)) writeFileSync(h, '日時,名簿数,人数一致,人数不一致,落ちた人,幽霊,対応付いた人\n', 'utf8')
appendFileSync(h, `${new Date().toISOString().slice(0, 16).replace('T', ' ')},${mails},${countOk},${countNg},${missing},${phantom},${matched}\n`, 'utf8')
console.log(`\n採点結果: ${OUT_DIR}`)
console.log(`採点にかかった量: $${cost.toFixed(4)}（Max枠なので実課金ではない）`)
