#!/usr/bin/env node
/**
 * メールボックスが上限に当たるまでの余裕を測る（2026-09-24）。
 *
 * 背景:
 *   2026-09-12 に「処理済みメールを完全削除せず削除済みアイテムへ移す」に変えた（d8fd877）。
 *   そのとき「30日を過ぎた分は Outlook が自動で消すので放っておいても溢れない」と
 *   書いたが、**まだ30日経っていないので自動削除は一度も観測できていない**。
 *   実測で 削除済み 17,760件（最古 09/12）。増え続けている。
 *
 *   過去に取り込みが止まった原因は容量ではなかった（8/28 bot判定・8/17 宛先違い）が、
 *   容量で止まる前に数字を押さえておく。
 *
 * 測りかた:
 *   ローカル控えの message.json が持つ `size`（Outlook のメールサイズ）を日別に合計する。
 *   **本番も Outlook も触らない。** 控えを読むだけ。
 *
 * 実行: node scripts/measure_mailbox_growth.mjs [--days 30]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/akinavi-archive/mail'
const i = process.argv.indexOf('--days')
const DAYS = i >= 0 ? Number(process.argv[i + 1]) : 30

const days = fs.readdirSync(ROOT)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-DAYS)

const rows = []
let grandN = 0, grandBytes = 0
for (const day of days) {
  const dayPath = path.join(ROOT, day)
  let entries
  try { entries = fs.readdirSync(dayPath) } catch { continue }
  let n = 0, bytes = 0
  for (const e of entries) {
    const mj = path.join(dayPath, e, 'message.json')
    if (!fs.existsSync(mj)) continue
    let msg
    // 控えの message.json は BOM 付き。剥がさないと全件パース失敗する
    try { msg = JSON.parse(fs.readFileSync(mj, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    n++
    bytes += Number(msg.size ?? 0)
  }
  rows.push({ day, n, bytes })
  grandN += n
  grandBytes += bytes
}

const mb = (b) => (b / 1024 / 1024).toFixed(1)
const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2)

console.log(`日別（直近${rows.length}日）`)
console.log(`${'日付'.padEnd(12)}${'通数'.padStart(7)}${'容量'.padStart(10)}`)
console.log('-'.repeat(30))
for (const r of rows.slice(-14)) {
  console.log(`${r.day.padEnd(12)}${String(r.n).padStart(7)}${(mb(r.bytes) + 'MB').padStart(10)}`)
}
console.log('-'.repeat(30))
console.log(`合計 ${grandN}通 / ${gb(grandBytes)}GB\n`)

// 直近7日の平均から先を読む
const last7 = rows.slice(-7)
const perDayN = last7.reduce((a, r) => a + r.n, 0) / (last7.length || 1)
const perDayB = last7.reduce((a, r) => a + r.bytes, 0) / (last7.length || 1)

console.log('直近7日の平均')
console.log(`  1日あたり ${Math.round(perDayN)}通 / ${mb(perDayB)}MB`)
console.log('')
console.log('保持30日で頭打ちになった場合の定常値（Outlookの自動削除が効く前提）')
console.log(`  件数 ${Math.round(perDayN * 30).toLocaleString()}件 / 容量 ${gb(perDayB * 30)}GB`)
console.log('')
console.log('自動削除が効かず溜まり続けた場合')
for (const d of [30, 60, 90, 180, 365]) {
  console.log(`  ${String(d).padStart(3)}日後: ${String(Math.round(perDayN * d).toLocaleString()).padStart(9)}件 / ${gb(perDayB * d).padStart(6)}GB`)
}
console.log('')
console.log('目安: Outlook.com 無料は 15GB、Microsoft 365 は 50GB〜。')
console.log('     1フォルダの件数はハード上限より先に動作が重くなる（数万件〜）。')
