#!/usr/bin/env node
/**
 * メール本文に書かれた「経歴書・スキルシートのリンク」がどのドメインかを数える（2026-09-23）。
 *
 * きっかけ:
 *   ユーザー指摘 —「●スキルシート：https://bit.ly/xxxx リンク内よりダウンロードいただけます」
 *   こういう短縮URLを経歴書として取れるか、という問い。
 *   現状 inbound-email は docs.google.com / drive.google.com しか見ていない。
 *
 * ここで測るのは「対応する価値があるか」。ドメインごとの出現数と、
 * 経歴書を指していそうな文脈（直前に「スキルシート」「経歴書」等がある）での出現数を分ける。
 *
 * **本番は引かない。** ローカル控え（archive_local.mjs が貯めた message.json）だけを読む。
 *
 * 実行:
 *   node scripts/measure_resume_link_domains.mjs [控えのmailディレクトリ] [--days 7]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'D:/akinavi-archive/mail'
const daysIdx = process.argv.indexOf('--days')
const DAYS = daysIdx >= 0 ? Number(process.argv[daysIdx + 1]) : 7

if (!fs.existsSync(ROOT)) {
  console.error(`控えが見つかりません: ${ROOT}`); process.exit(1)
}

const dayDirs = fs.readdirSync(ROOT)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .sort()
  .slice(-DAYS)

/** 経歴書を指していそうな文脈か（URLの前後120文字に手がかりがあるか） */
const RESUME_HINT = /スキルシート|経歴書|技術経歴|職務経歴|レジュメ|skill\s*sheet|プロフィールシート/i
const URL_RE = /https?:\/\/[^\s"'<>）」】、,]+/g

const byDomain = new Map()   // domain -> { total, resume }
let mails = 0, withAnyUrl = 0

for (const day of dayDirs) {
  const dayPath = path.join(ROOT, day)
  let entries
  try { entries = fs.readdirSync(dayPath) } catch { continue }
  for (const e of entries) {
    const mj = path.join(dayPath, e, 'message.json')
    if (!fs.existsSync(mj)) continue
    let msg
    try { msg = JSON.parse(fs.readFileSync(mj, 'utf8')) } catch { continue }
    const body = String(msg.body ?? '')
    if (!body) continue
    mails++
    let found = false
    for (const m of body.matchAll(URL_RE)) {
      const url = m[0]
      let host
      try { host = new URL(url).hostname.replace(/^www\./, '') } catch { continue }
      found = true
      const around = body.slice(Math.max(0, m.index - 120), m.index + 120)
      const isResume = RESUME_HINT.test(around)
      const cur = byDomain.get(host) ?? { total: 0, resume: 0 }
      cur.total++
      if (isResume) cur.resume++
      byDomain.set(host, cur)
    }
    if (found) withAnyUrl++
  }
}

const rows = [...byDomain.entries()]
  .map(([host, v]) => ({ host, ...v }))
  .sort((a, b) => b.resume - a.resume || b.total - a.total)

console.log(`控え: ${ROOT}（直近${dayDirs.length}日: ${dayDirs[0]} 〜 ${dayDirs.at(-1)}）`)
console.log(`メール ${mails}通 / URLを含む ${withAnyUrl}通\n`)
console.log('ドメイン別（「経歴書の文脈」＝前後120字にスキルシート/経歴書等がある）')
console.log(`${'ドメイン'.padEnd(34)} 経歴書の文脈  全体`)
console.log('-'.repeat(56))
const GOOGLE = /^(docs|drive)\.google\.com$/
let googleResume = 0, otherResume = 0
for (const r of rows.slice(0, 25)) {
  const mark = GOOGLE.test(r.host) ? '取得済' : '未対応'
  console.log(`${r.host.padEnd(34)} ${String(r.resume).padStart(8)} ${String(r.total).padStart(7)}  ${mark}`)
}
for (const r of rows) {
  if (GOOGLE.test(r.host)) googleResume += r.resume
  else otherResume += r.resume
}
console.log('-'.repeat(56))
console.log(`経歴書の文脈のURL: 対応済み(Google) ${googleResume}件 / 未対応 ${otherResume}件`)
