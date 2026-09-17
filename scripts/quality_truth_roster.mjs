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
  // 読み仮名の括弧を落とす。本文は「叢H（ソウ）」、DBは「叢H」で入るので、
  // 残したままだと同じ人が「落ちた人」と「幽霊」に二重計上される（2026-09-17 実測3人）
  .replace(/[（(][ぁ-んァ-ヶー\s　]{1,12}[）)]\s*$/, '')
  .replace(/[\s　.・,，、\-‐―ー_]/g, '')
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .toLowerCase()

// ── 突き合わせの鍵を作る ────────────────────────────────────────────────────
//
// ⚠ 2026-09-17: 鍵は「送信元 + emailReceivedAt（分）」だが、**これだけでは足りない**。
// 同じ人が毎日の一斉配信で再送されると、既存行が UPDATE され emailReceivedAt が
// 最新のメールに**貼り替わる**。つまり古いメールを採点すると、生きている人が
// 軒並み「落ちた人」に見える。
//   実例: j-tech の9/14メール（本文34人）は prod に4人しか紐づいていないが、
//         残りは9/17のメールに貼り替わっているだけで全員生きている。
// そこで「落ちた人」の判定には**送信元ごとの全氏名**を使い、
// 「幽霊」と項目の採点にはこのメールに紐づく行だけを使う（値はこの通のものなので）。
//
// ⚠ さらに、その「送信元」は**ドメインで見る**こと。1社が複数の担当者アドレスから
// 同じ人材を送ってくる（実測: j-tech.co.jp は n.yamazaki@ / m.onda@ / s.nakayama@ /
// anken@ の4アドレス）。人材行の from は最後に書いたメールのアドレスになるので、
// アドレス単位で照合すると「別の担当者から登録済みの人」が落ちた人に化ける。
const domainOf = (addr) => String(addr ?? '').toLowerCase().split('@')[1] ?? ''
const actual = new Map()
const byDomain = new Map()
for (const c of dbRows('candidates')) {
  const sender = String(c.rp_from ?? '').toLowerCase()
  const k = `${sender}|${utcMinute(c.rp_received)}`
  if (!actual.has(k)) actual.set(k, [])
  actual.get(k).push(c)
  const d = domainOf(sender)
  if (!byDomain.has(d)) byDomain.set(d, new Set())
  byDomain.get(d).add(nameKey(c.name))
}

// ⚠ DB側の控えは archive_local.mjs が1日1回取る。メール側は15分おきに増える。
// 地平線が違うまま採点すると、控えより新しいメールの人が全員「落ちた人」に化ける
// （2026-09-17: 控えは9/16まで、j-tech の9/17メールの27人が丸ごと未収録だった）。
// 控えに入っている最新日より後に届いたメールは採点しない。
const dbNewestDay = (() => {
  const dir = join(DB_DIR, 'candidates')
  if (!existsSync(dir)) return null
  const days = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
  return days.length ? days[days.length - 1].slice(0, 10) : null
})()

const mailsByKey = new Map()
for (const day of readdirSync(MAIL_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
  if (dbNewestDay && day > dbNewestDay) continue
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
${String(m.body ?? '').slice(0, BODY_LIMIT)}`

/** 正解づくりに渡す本文の上限。
 *
 *  ⚠ 2026-09-17: ここは 12,000 だった。1通に34人が並ぶメールの本文は約60,000字あるので、
 *  正解側が**先頭の9人しか見えていなかった**。それを「本文9人 → DB5人」と読んで
 *  「名簿の分割がおかしい」と報告したが、実際に splitMultiCandidateBody に通すと
 *  34ブロックに正しく割れていた。**測り方の欠陥を製品の不具合として報告していた**。
 *
 *  上限を超えたメールは、人数の採点から外して「未採点」として数える。
 *  黙って切り詰めると、切り落とした人が全員「落ちた人」に化けて数字が嘘になる。 */
const BODY_LIMIT = 120000

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
let countOk = 0, countNg = 0, countSkipLong = 0, ambiguous = 0
let missing = 0, phantom = 0, matched = 0, dbTotal = 0, truthTotal = 0
const stats = new Map(FIELDS.map(([f]) => [f, { ok: 0, ng: 0, dbNull: 0, truthNull: 0 }]))
const notes = []

for (const [i, t] of targets.entries()) {
  process.stdout.write(`\r採点中 ${i + 1}/${targets.length}…`)
  const bodyTruncated = String(t.mail.body ?? '').length > BODY_LIMIT
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
  truthTotal += truthPeople.length

  // ── 同じイニシャルの別人を潰さずに対応付ける ──────────────────────────────
  //
  // ⚠ 2026-09-17: ここは `new Map(rows.map(r => [nameKey(r.name), r]))` だった。
  // 名簿には同じイニシャルの別人が普通に並ぶ（実測: j-tech の34人メールに
  // AK・YK・TY・MT・UK・TM が各2人）。Map は後勝ちで片方を捨てるので、
  //   ・捨てられた方が毎回「落ちた人」に化ける
  //   ・残った方に相手の値をぶつけて「駅が違う・年齢が違う」と誤判定する
  // （実際 AK を「一宮駅→亀戸駅、51歳→46歳」とズレとして報告したが、別人だった）
  //
  // 名前が同じ候補が複数いる場合は、年齢・駅・単価が最も多く一致する行を選ぶ。
  // 一度使った行は他の人に割り当てない（1対1を保つ）。
  //
  // さらに、本文に同名が2人いるのにこのメールに紐づく行が1つしか無いことがある
  // （もう1人は後日の再送で別のメールに貼り替わっている）。このとき残った1行を
  // どちらの人に当てるかは決められないので、**その氏名は採点しない**。
  // 当てずっぽうで当てると「駅が違う・年齢が違う」という嘘の不一致が出る
  // （実際 YK・MT・AK でそれが起きていた）。
  const truthNameCount = new Map()
  for (const p of truthPeople) truthNameCount.set(nameKey(p.name), (truthNameCount.get(nameKey(p.name)) ?? 0) + 1)
  const rowNameCount = new Map()
  for (const r of t.rows) rowNameCount.set(nameKey(r.name), (rowNameCount.get(nameKey(r.name)) ?? 0) + 1)
  const ambiguousName = (k) => truthNameCount.get(k) > 1 && truthNameCount.get(k) !== rowNameCount.get(k)

  const usedRows = new Set()
  const pickRow = (p) => {
    if (ambiguousName(nameKey(p.name))) { ambiguous++; return null }
    const cands = t.rows.filter((r) => !usedRows.has(r) && nameKey(r.name) === nameKey(p.name))
    if (cands.length === 0) return null
    const score = (r) => FIELDS.reduce((n, [f, get]) => {
      const exp = norm(f, p[f]); const act = norm(f, get(r))
      return n + (exp !== null && exp === act ? 1 : 0)
    }, 0)
    const best = cands.reduce((a, b) => (score(b) > score(a) ? b : a))
    usedRows.add(best)
    return best
  }
  const rowOf = new Map()
  for (const p of truthPeople) {
    const r = pickRow(p)
    if (r) rowOf.set(p, r)
  }
  dbTotal += t.rows.length

  // 本文が上限を超えたメールは、正解側が全員を見られていないので人数の採点から外す。
  // 切り詰めた分を「落ちた人」に数えると、測り方の都合が製品の不具合に見える
  // 落ちた人は「その会社（ドメイン）の人材に1人もいない」で判定する（再送で貼り替わるため）
  const senderNames = byDomain.get(domainOf(t.mail.from)) ?? new Set()
  const missedHere = bodyTruncated ? [] : truthPeople.filter((p) => !senderNames.has(nameKey(p.name)))

  if (bodyTruncated) {
    countSkipLong++
    notes.push(`未採点: 本文が${Math.round(String(t.mail.body ?? '').length / 1000)}千字（上限${BODY_LIMIT / 1000}千字）「${String(t.mail.subject).slice(0, 40)}」`)
  } else if (missedHere.length === 0) countOk++
  else {
    countNg++
    notes.push(`取りこぼし: 本文${truthPeople.length}人のうち${missedHere.length}人が送信元の人材に居ない  「${String(t.mail.subject).slice(0, 40)}」`)
  }

  if (!bodyTruncated) {
    for (const p of missedHere) {
      missing++
      notes.push(`  落ちた: 「${p.name}」 ← ${String(t.mail.subject).slice(0, 40)}`)
    }
    // 幽霊はこのメールに紐づく行だけで見る（この通が最後に書いた行なので責任が言える）。
    // 同名が複数いて対応を決められなかった氏名は、幽霊にも落ちた人にも数えない
    for (const r of t.rows) {
      if (ambiguousName(nameKey(r.name))) continue
      if (!usedRows.has(r)) {
        phantom++
        notes.push(`  幽霊  : 「${r.name}」 ← ${String(t.mail.subject).slice(0, 40)}`)
      }
    }
  }

  // 名前で対応が付いた人だけ項目を採点する
  for (const p of truthPeople) {
    const row = rowOf.get(p)
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
console.log(`  本文の人が全員DBにいる  ${countOk} / ${countOk + countNg}`
  + (countSkipLong ? `（本文が長すぎて未採点 ${countSkipLong}件は除く）` : ''))
console.log(`  ★落ちた人（本文にいるのにDBに無い）  ${missing}`)
console.log(`  ★幽霊  （DBにいるのに本文に無い）    ${phantom}`)
console.log(`  名前で対応が付いた人              ${matched}`)
if (ambiguous) console.log(`  同名が複数いて決められず未採点    ${ambiguous}`)
console.log('')
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
