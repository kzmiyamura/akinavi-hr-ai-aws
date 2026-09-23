#!/usr/bin/env node
/**
 * ローカル控えのメールを件名で探して中身を出す（2026-09-23）。
 *
 * 読み取り結果の検証は「原本と突き合わせる」のが唯一の方法。
 * 本番からは引かず、控え（archive_local.mjs が貯めた message.json）だけを読む。
 *
 * ⚠ message.json は **BOM付き**。剥がさずに JSON.parse すると必ず例外になり、
 *    「1通も見つからない」という嘘の結果になる（2026-09-23 に踏んだ）。
 *
 * 実行:
 *   node scripts/show_archived_mail.mjs --subject "【GH要員】" [--day 2026-09-23] [--chars 4000]
 *   node scripts/show_archived_mail.mjs --from granthope.jp --list
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/akinavi-archive/mail'
const argStr = (n, d = '') => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? String(process.argv[i + 1] ?? d) : d
}
const argNum = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const SUBJECT = argStr('subject')
const FROM = argStr('from')
const DAY = argStr('day')
const CHARS = argNum('chars', 4000)
const LIST_ONLY = process.argv.includes('--list')

const days = fs.readdirSync(ROOT)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .filter((d) => !DAY || d === DAY)
  .sort()

const hits = []
for (const day of days) {
  const dayPath = path.join(ROOT, day)
  let entries
  try { entries = fs.readdirSync(dayPath) } catch { continue }
  for (const e of entries) {
    const mj = path.join(dayPath, e, 'message.json')
    if (!fs.existsSync(mj)) continue
    let msg
    try { msg = JSON.parse(fs.readFileSync(mj, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const subj = String(msg.subject ?? '')
    const from = String(msg.from ?? '')
    if (SUBJECT && !subj.includes(SUBJECT)) continue
    if (FROM && !from.includes(FROM)) continue
    hits.push({ day, dir: path.join(dayPath, e), msg })
  }
}

hits.sort((a, b) => String(a.msg.receivedTime ?? '').localeCompare(String(b.msg.receivedTime ?? '')))

if (hits.length === 0) { console.log('該当なし'); process.exit(0) }

if (LIST_ONLY) {
  for (const h of hits) {
    console.log(`${h.msg.receivedTime ?? '?'}  添付${(h.msg.attachments ?? []).length}  ${String(h.msg.subject ?? '').slice(0, 70)}`)
  }
  console.log(`\n${hits.length}通`)
  process.exit(0)
}

const h = hits.at(-1)   // 一番新しいもの
console.log(`受信      : ${h.msg.receivedTime}`)
console.log(`送信元    : ${h.msg.from}`)
console.log(`件名      : ${h.msg.subject}`)
console.log(`添付      : ${(h.msg.attachments ?? []).map((a) => `${a.original}(${Math.round((a.size ?? 0) / 1024)}KB)`).join(', ') || 'なし'}`)
console.log(`保存場所  : ${h.dir}`)
console.log(`本文の長さ: ${String(h.msg.body ?? '').length}字`)
console.log(`${'='.repeat(78)}`)
console.log(String(h.msg.body ?? '').slice(0, CHARS))
if (String(h.msg.body ?? '').length > CHARS) console.log(`\n…（残り ${String(h.msg.body).length - CHARS}字）`)
