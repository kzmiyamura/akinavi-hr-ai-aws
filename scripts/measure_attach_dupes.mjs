#!/usr/bin/env node
/**
 * ローカル控え（D:\akinavi-archive\mail）の添付ファイルの重複を測る。
 *
 * 目的: AI校正の効率。経歴書1件の解析は実測 114秒かかる（llm_shadow 直近7日・avg_sec）。
 * 同じ経歴書が別メールで何度も届いているなら、**中身のハッシュで引き当てるだけで
 * その回数ぶん丸ごと省ける**。省けるかどうかは実データで数えないと分からないので数える。
 *
 * 本番を一切引かない（egress ゼロ）。
 *
 * 使い方:
 *   node scripts/measure_attach_dupes.mjs [--dir D:\akinavi-archive\mail] [--days 7]
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROOT = argOf('--dir', 'D:\\akinavi-archive\\mail')
const DAYS = Number(argOf('--days', '7'))

/** 解析対象の拡張子。worker の extMatch と同じ集合 */
const PARSEABLE = /\.(xlsx?|xlsm|docx|pdf)$/i

const since = new Date(Date.now() - DAYS * 86400_000)
const dayDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => new Date(`${d.name}T23:59:59Z`) >= since)
  .map((d) => d.name)
  .sort()

const byHash = new Map()   // hash -> { n, bytes, names:Set }
let files = 0, bytes = 0, mails = 0

for (const day of dayDirs) {
  const dayPath = path.join(ROOT, day)
  for (const mail of fs.readdirSync(dayPath, { withFileTypes: true })) {
    if (!mail.isDirectory()) continue
    mails++
    const mailPath = path.join(dayPath, mail.name)
    for (const f of fs.readdirSync(mailPath, { withFileTypes: true })) {
      if (!f.isFile() || !PARSEABLE.test(f.name)) continue
      const fp = path.join(mailPath, f.name)
      let buf
      try { buf = fs.readFileSync(fp) } catch { continue }
      const h = crypto.createHash('sha256').update(buf).digest('hex')
      files++
      bytes += buf.length
      let e = byHash.get(h)
      if (!e) { e = { n: 0, bytes: buf.length, names: new Set() }; byHash.set(h, e) }
      e.n++
      e.names.add(f.name)
    }
  }
}

const uniq = byHash.size
const dupCopies = files - uniq
const SEC_PER_CALL = 114   // llm_shadow 直近7日の attachment avg_sec 実測

console.log(`対象      : ${dayDirs.length}日分 (${dayDirs[0]} 〜 ${dayDirs[dayDirs.length - 1]}) / メール ${mails}通`)
console.log(`添付      : ${files}ファイル ${(bytes / 1048576).toFixed(0)}MB`)
console.log(`内容の種類: ${uniq}種`)
console.log(`重複      : ${dupCopies}ファイル (${files ? (dupCopies / files * 100).toFixed(1) : 0}%)`)
console.log(`→ ハッシュで引き当てれば ${dupCopies}回の解析を省ける = 約${(dupCopies * SEC_PER_CALL / 3600).toFixed(1)}時間/${DAYS}日`)

const top = [...byHash.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)
console.log(`\n■ 同じ中身が何通にも入っていたもの 上位15`)
for (const [h, e] of top) {
  if (e.n < 2) break
  console.log(`  ${String(e.n).padStart(4)}回  ${(e.bytes / 1024).toFixed(0).padStart(5)}KB  ${[...e.names].slice(0, 3).join(' / ').slice(0, 70)}`)
}
