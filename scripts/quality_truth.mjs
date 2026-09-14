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

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
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

// 原本を全部読み、鍵（差出人＋受信時刻）ごとに数える。
// **同じ差出人が同じ分に複数通送る**ことがあり、鍵が衝突すると
// 別のメールの内容を同じ人材と突き合わせてしまう
// （2026-09-15 の初回実行で、3通が同じ人材 M.Y に対応付いて全項目が不一致になった）。
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

// 採点できるのは「メール1通 ↔ 人材1行」が確実に言える組み合わせだけ
const targets = []
for (const [k, mails] of mailsByKey) {
  if (mails.length !== 1) continue           // 同じ分に複数通 → どれがどれか決められない
  const rows = actual.get(k)
  if (!rows || rows.length !== 1) continue   // 複数人メール → 同上
  targets.push({ mail: mails[0], row: rows[0] })
  if (targets.length >= LIMIT) break
}

if (targets.length === 0) {
  // 日次で回すので、ここで異常終了させると毎日「失敗」に見える。
  // ただし何日も0が続くのは**対応付けが壊れた合図**なので、記録には0を残す
  mkdirSync(OUT_DIR, { recursive: true })
  const h = join(OUT_DIR, '_history.csv')
  if (!existsSync(h)) writeFileSync(h, '日時,採点数,項目,一致,不一致,DBが空,記載なし,正答率\n', 'utf8')
  appendFileSync(h, `${new Date().toISOString().slice(0, 16).replace('T', ' ')},0,(採点対象なし),,,,,\n`, 'utf8')
  console.log('採点できる組み合わせがありません（原本とDB行が1対1で対応するものが無い）')
  console.log('回収が進むと増えます。0 が続くようなら outlook_export.ps1 / archive_local.mjs を確認すること')
  process.exit(0)
}

const PROMPT = (m) => `あなたは人材紹介メールを読む採用担当です。
下のメールから、**本文に明示されている場合のみ**次の項目を JSON で出してください。
書かれていない・読み取れない項目は null にしてください。推測で埋めないこと。

- personCount: このメールで紹介されている技術者の人数（数値）。1人なら 1
- name: 技術者の氏名やイニシャル（例 "A.S" "田中" "KT"）。複数人なら最初の1人
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

/**
 * 比べる前に表記を揃える。**同じことを言っているのに不一致にしない。**
 * 初回実行では「男性 vs 男」「日本 vs 日本籍」「南浦和 vs JR南浦和」が
 * すべて不一致に数えられ、性別の正答率が 8% という嘘の数字になった（2026-09-15）。
 */
function norm(field, v) {
  if (v === null || v === undefined || v === '') return null
  let s = String(v).trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .replace(/[．。]/g, '.')
    .toLowerCase()

  if (field === 'gender') {
    if (/^(男性|男)$/.test(s)) return '男'
    if (/^(女性|女)$/.test(s)) return '女'
  }
  if (field === 'nationality') {
    // 「日本」「日本籍」「日本人」は同じ
    s = s.replace(/[籍人]$/, '')
  }
  if (field === 'nearestStation') {
    // 事業者名の前置き（JR／東京メトロ／都営…）と末尾の「駅」は表記の違い
    s = s.replace(/^(?:jr[東西九州海道本]*|ＪＲ|東京メトロ|都営(?:地下鉄)?|地下鉄|新交通|京王|小田急|東急|西武|東武|京成|京急|相鉄|名鉄|近鉄|阪急|阪神|南海)/, '')
         .replace(/駅$/, '')
  }
  if (field === 'age') s = s.replace(/[歳才]$/, '')
  if (field === 'desiredRate') {
    // 「65万」「65万円」「65万円/月」は同じ。前後の説明文は落とす
    const m = s.match(/(\d{2,3})万/)
    if (m) return `${Number(m[1])}万`
  }
  if (field === 'experienceYears') {
    const m = s.match(/(\d+(?:\.\d+)?)/)
    if (m) return String(Math.floor(Number(m[1])))   // 2.75年 と 2年 は同じ扱い
  }
  if (/^\d+$/.test(s)) s = String(Number(s))
  return s || null
}

const stats = new Map(FIELDS.map(([f]) => [f, { ok: 0, ng: 0, dbNull: 0, truthNull: 0 }]))
const mismatches = []
let totalCost = 0
let skippedMulti = 0

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

  // 1通に複数人が書かれているメールは、どの人とDB行が対応するか決められない
  if (Number(truth.personCount ?? 1) !== 1) { skippedMulti++; continue }

  // 採点者は**本文しか読んでいない**。経歴書が添付されている場合、DBの経験年数は
  // 添付の案件期間から計算された値で、本文の申告値と食い違って当然。
  // ここを不一致に数えると指標が嘘になる（2026-09-15: 36% と出たが多くは正当な差）。
  const hasAttachment = (t.mail.attachments ?? []).length > 0

  for (const [field, get] of FIELDS) {
    const s = stats.get(field)
    if (field === 'experienceYears' && hasAttachment) { s.truthNull++; continue }
    const exp = norm(field, truth[field])
    const act = norm(field, get(t.row))
    if (exp === null) { s.truthNull++; continue }      // 本文に書いていない＝採点対象外
    if (act === null) { s.dbNull++; mismatches.push(`${field}: 本文「${truth[field]}」→ DBは空  (${t.row.name})`); continue }
    if (exp === act) s.ok++
    else { s.ng++; mismatches.push(`${field}: 本文「${truth[field]}」→ DBは「${get(t.row)}」  (${t.row.name})`) }
  }
}

console.log(`\n\n採点 ${targets.length - skippedMulti} 通（原本とDB行が1対1のものだけ）`)
if (skippedMulti > 0) console.log(`  ${skippedMulti} 通は複数人メールのため除外`)
console.log('')
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
// ── 推移を残す ──────────────────────────────────────────────
// 抽出を直したときに「本当に良くなったか」を数字で言えるようにする。
// 1回1項目1行の長い形。表計算でも grep でも読める
const HIST = join(OUT_DIR, '_history.csv')
if (!existsSync(HIST)) {
  writeFileSync(HIST, '日時,採点数,項目,一致,不一致,DBが空,記載なし,正答率\n', 'utf8')
}
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
let histLines = ''
for (const [field, s] of stats) {
  const judged = s.ok + s.ng + s.dbNull
  const rate = judged === 0 ? '' : ((s.ok / judged) * 100).toFixed(1)
  histLines += `${stamp},${targets.length},${field},${s.ok},${s.ng},${s.dbNull},${s.truthNull},${rate}\n`
}
appendFileSync(HIST, histLines, 'utf8')

console.log(`\n採点結果: ${OUT_DIR}`)
console.log(`推移: ${HIST}`)
// Max 枠で回しているので実課金ではない。1通あたりの重さの目安として出す
console.log(`採点にかかった量: $${totalCost.toFixed(4)}（Max枠なので実課金ではない）`)
