#!/usr/bin/env node
// ローカル控えから件名でメールを探す（本番は引かない）。
//   node scripts/find_mail.mjs "件名の一部" [--days 7]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAIL_DIR = resolve(process.env.AKINAVI_MAIL_DIR ?? 'D:\\akinavi-archive\\mail')
const args = process.argv.slice(2)
const q = args.find((a) => !a.startsWith('--'))
if (!q) { console.error('使い方: node scripts/find_mail.mjs "件名の一部" [--days 7]'); process.exit(1) }
const di = args.indexOf('--days')
const days = di >= 0 ? Number(args[di + 1]) : 7

const dirs = readdirSync(MAIL_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, days)
let hits = 0
for (const day of dirs) {
  for (const msg of readdirSync(join(MAIL_DIR, day))) {
    const p = join(MAIL_DIR, day, msg, 'message.json')
    if (!existsSync(p)) continue
    let m
    try { m = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    if (!String(m.subject ?? '').includes(q)) continue
    hits++
    console.log(`${m.receivedTime ?? ''}  ${m.from ?? ''}`)
    console.log(`  ${m.subject}`)
    console.log(`  ${p}`)
  }
}
if (hits === 0) console.log(`直近${days}日の控えに該当なし`)
