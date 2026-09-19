#!/usr/bin/env node
/**
 * ローカル控えのメール通数を日別に数える（本番を引かない）。
 * 「1日何通届いているのか」を DB の人材登録数と突き合わせるために使う。
 * 添付ありの通数も出す（AI校正の重い側＝経歴書解析の母数になるため）。
 *
 *   node scripts/count_archive_mail.mjs [--dir D:\akinavi-archive\mail]
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROOT = argOf('--dir', 'D:\\akinavi-archive\\mail')
const PARSEABLE = /\.(xlsx?|xlsm|docx|pdf)$/i

const days = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .map((d) => d.name).sort()

console.log('日付        通数   添付あり  添付数')
for (const day of days) {
  const dayPath = path.join(ROOT, day)
  let mails = 0, withAttach = 0, attach = 0
  for (const m of fs.readdirSync(dayPath, { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    mails++
    const n = fs.readdirSync(path.join(dayPath, m.name)).filter((f) => PARSEABLE.test(f)).length
    if (n) { withAttach++; attach += n }
  }
  console.log(`${day}  ${String(mails).padStart(5)}  ${String(withAttach).padStart(7)}  ${String(attach).padStart(6)}`)
}
