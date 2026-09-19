#!/usr/bin/env node
/**
 * inbound-email の「関連性フィルター」を控えのメールに当て直し、
 * **どのキーワードで捨てられたか**を1通ずつ特定する。
 *
 * 背景（2026-09-19 実測・ai_logs の実記録）: 直近7日で人材メールが
 *   COMMERCIAL_SOLICITATION 928通 / PROJECT_SOLICITATION 280通
 * 捨てられていた。y.sasaki@free-brain.co.jp は209通すべてこれで、
 * 中身は【氏名】K.R【年齢】61歳【単価】100万円 の正真正銘の人材メールだった。
 *
 * どの語に当たったかが分からないと直しようがない。**語を特定してから直す**。
 * レプリカは作らず、本番の index.ts から定数をそのまま切り出す。
 *
 * 本番を一切引かない（egress ゼロ）。
 *
 *   node scripts/replay_relevance_gate.mjs [--top 30] [--sender y.sasaki@free-brain.co.jp]
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const SRC = argOf('--src', 'supabase/functions/inbound-email/index.ts')
const TOP = Number(argOf('--top', '30'))
const ONLY_SENDER = argOf('--sender', '')

/** index.ts から配列定数をそのまま取り出す（レプリカを書かない） */
function loadArray(src, name) {
  const start = src.indexOf(`const ${name} = [`)
  if (start < 0) throw new Error(`${name} が見つかりません`)
  const open = src.indexOf('[', start)
  let depth = 0, i = open
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') { depth--; if (depth === 0) break }
  }
  return new Function(`return ${src.slice(open, i + 1)}`)()
}

const src = fs.readFileSync(SRC, 'utf8')
const TRAINING = loadArray(src, 'TRAINING_KEYWORDS')
const SOLICIT = loadArray(src, 'PROJECT_SOLICITATION_KEYWORDS')
const COMMERCIAL = loadArray(src, 'COMMERCIAL_SOLICITATION_KEYWORDS')
const SUBJ_SKIP = loadArray(src, 'SUBJECT_SKIP_KEYWORDS')

/** inbound-email と同じ本文整形（HTML除去 + 実体参照デコード） */
const decodeEntities = (t) => String(t)
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
const stripHtml = (h) => h
  .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, '')
const bodyOf = (m) => {
  const raw = typeof m.body === 'string' ? m.body : (m.body?.content ?? m.bodyPreview ?? '')
  const isHtml = typeof m.body === 'string'
    ? /<(?:html|body|div|br|p)\b/i.test(raw)
    : (m.body?.contentType ?? '').toLowerCase() === 'html'
  return decodeEntities(isHtml ? stripHtml(raw) : raw)
}
const addrOf = (f) => (typeof f === 'string' ? f : (f?.emailAddress?.address ?? '')).toLowerCase().trim()

const days = fs.readdirSync(MAIL_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => fs.readdirSync(path.join(MAIL_ROOT, d.name)).length > 100)
  .map((d) => d.name).sort()

/** 判定順は本番と同じ: TRAINING → PROJECT_SOLICITATION → SUBJECT_KEYWORD → COMMERCIAL */
function gate(subject, body) {
  const t = TRAINING.find((k) => body.includes(k))
  if (t) return { reason: 'TRAINING_REPORT', kw: t }
  const s = SOLICIT.find((k) => body.includes(k))
  if (s) return { reason: 'PROJECT_SOLICITATION', kw: s }
  const isJobReq = /【.{1,20}】[〜~]?\d+万.*(がある方|できる方|歳まで|以上の経験|歳以下)/.test(subject)
  const sk = SUBJ_SKIP.find((k) => subject.includes(k))
  if (sk || isJobReq) return { reason: 'SUBJECT_KEYWORD', kw: sk ?? '(件名が案件条件の形)' }
  const c = COMMERCIAL.find((k) => body.includes(k))
  if (c) return { reason: 'COMMERCIAL_SOLICITATION', kw: c }
  if (body.includes('NDAにつきましては')) return { reason: 'COMMERCIAL_SOLICITATION', kw: 'NDAにつきましては' }
  if (body.includes('CloudSignでの締結')) return { reason: 'COMMERCIAL_SOLICITATION', kw: 'CloudSignでの締結' }
  return null
}

/** 本番の門番 bodyHasCandidateProfile をそのまま切り出す。
 *  「人の履歴があるメールには営業判定を掛けない」バイパスが、実データで
 *  どれだけ効くかを測るため。レプリカを書くと本番とズレるので必ず切り出す。 */
function loadProfileGate() {
  const m = src.match(/function bodyHasCandidateProfile\(([\s\S]*?)\n\}/)
  if (!m) return null
  const js = `function bodyHasCandidateProfile(${m[1]}\n}\nreturn bodyHasCandidateProfile`
    .replace(/:\s*string/g, '').replace(/:\s*boolean/g, '')
  return new Function(js)()
}
const profileGate = loadProfileGate()

/** その本文が人材メールの体裁か（誤爆かどうかの手がかり）。
 *  本番に門番が入っていればそれを使い、無ければ従来の目安で数える */
const looksLikeCandidate = profileGate ?? ((b) =>
  /(氏\s*名|お名前|【名\s*前】|【氏\s*名】|要員番号)/.test(b) &&
  /(\d{2}\s*歳|年\s*齢|単\s*価|最寄|稼[働動])/.test(b))

const hit = new Map()   // "理由｜語" → {n, cand, senders:Set, sample}
let scanned = 0, dropped = 0, droppedCand = 0, bypassed = 0

for (const day of days) {
  const dayDir = path.join(MAIL_ROOT, day)
  for (const m of fs.readdirSync(dayDir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const jf = path.join(dayDir, m.name, 'message.json')
    if (!fs.existsSync(jf)) continue
    let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const from = addrOf(j.from)
    if (ONLY_SENDER && from !== ONLY_SENDER) continue
    const subject = String(j.subject ?? '')
    const body = bodyOf(j)
    scanned++
    const g = gate(subject, body)
    if (!g) continue
    dropped++
    const isCand = looksLikeCandidate(body)
    // 本番に門番が入っていれば、人の履歴があるものは実際には捨てられない
    if (profileGate && isCand) { bypassed++; continue }
    if (isCand) droppedCand++
    const k = `${g.reason}｜${g.kw}`
    if (!hit.has(k)) hit.set(k, { n: 0, cand: 0, senders: new Set(), sample: '' })
    const e = hit.get(k)
    e.n++; if (isCand) e.cand++
    e.senders.add(from)
    if (isCand && !e.sample) e.sample = `${from} / ${subject.slice(0, 55)}`
  }
}

console.log(`対象: ${days.length}日 / 走査 ${scanned}通`)
console.log(`関連性フィルターの語に当たる: ${dropped}通`)
if (profileGate) {
  console.log(`  うち人の履歴があり門番でバイパスされる: ${bypassed}通 ← 救済される`)
  console.log(`  実際に捨てられる: ${dropped - bypassed}通（うち人材の体裁 ${droppedCand}通）\n`)
} else {
  console.log(`  うち **人材メールの体裁**（氏名＋年齢/単価/最寄駅）: ${droppedCand}通 ← 誤爆の疑い`)
  console.log(`  ※本番に bodyHasCandidateProfile が無いため、バイパス前の数字\n`)
}
console.log(`■ 実際に捨てられるものの内訳（上位${TOP}）`)
console.log('   捨てた  うち人材  送信元数  理由 / 語')
for (const [k, e] of [...hit].sort((a, b) => b[1].cand - a[1].cand).slice(0, TOP)) {
  console.log(`   ${String(e.n).padStart(6)}  ${String(e.cand).padStart(8)}  ${String(e.senders.size).padStart(8)}  ${k}`)
  if (e.sample) console.log(`             例: ${e.sample}`)
}
