#!/usr/bin/env node
/**
 * 実メールで「辿る/辿らない」の門番が正しく効いているかを確認する（2026-09-23）。
 *
 * 一番怖いのは **配信停止リンクを踏むこと**。踏むと取引先からのメールが止まり、
 * 人材の流入そのものが消える。合成テストだけでは実際の文面の揺れを拾えないので、
 * ローカル控えの本文すべてに門番を掛けて、拾う側・捨てる側を目で確認する。
 *
 * **本番は引かない。** 外部にも当たらない（判定だけ・HTTPは投げない）。
 *
 * 実行: node scripts/verify_follow_link_gate.mjs [--days 7]
 */
import fs from 'node:fs'
import path from 'node:path'
import { shouldFollowResumeLink } from './_extractors.gen.mjs'

const ROOT = 'D:/akinavi-archive/mail'
const i = process.argv.indexOf('--days')
const DAYS = i >= 0 ? Number(process.argv[i + 1]) : 7

const dayDirs = fs.readdirSync(ROOT)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-DAYS)

const URL_RE = /https?:\/\/[^\s"'<>）」】、,]+/g
/** 配信停止っぽい文言（門番とは別に、こちらで「本当に危ないもの」を数える） */
const DANGER = /配信[^。\n]{0,8}(停止|解除)|unsubscribe|opt[-_]?out|購読[^。\n]{0,4}解除|退会/i

let mails = 0, urls = 0
const followed = []          // 辿ると判断したもの
let dangerSeen = 0, dangerFollowed = 0
const byHost = new Map()

for (const day of dayDirs) {
  const dayPath = path.join(ROOT, day)
  let entries
  try { entries = fs.readdirSync(dayPath) } catch { continue }
  for (const e of entries) {
    const mj = path.join(dayPath, e, 'message.json')
    if (!fs.existsSync(mj)) continue
    let msg
    // 控えの message.json は BOM 付き。剥がさないと全件パース失敗する
    try { msg = JSON.parse(fs.readFileSync(mj, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const body = String(msg.body ?? '')
    if (!body) continue
    mails++
    for (const m of body.matchAll(URL_RE)) {
      urls++
      const url = m[0]
      const around = body.slice(Math.max(0, m.index - 120), m.index + 120)
      const danger = DANGER.test(url) || DANGER.test(around)
      if (danger) dangerSeen++
      if (!shouldFollowResumeLink(url, around)) continue
      if (danger) { dangerFollowed++; console.log(`⚠ 危険なのに辿る判定: ${url}\n   文脈: ${around.replace(/\s+/g, ' ').slice(0, 140)}`) }
      followed.push(url)
      let h = '(不明)'
      try { h = new URL(url).hostname.replace(/^www\./, '') } catch { /* noop */ }
      byHost.set(h, (byHost.get(h) ?? 0) + 1)
    }
  }
}

console.log(`\n控え ${dayDirs.length}日 / メール ${mails}通 / URL ${urls}件`)
console.log(`辿ると判断した                : ${followed.length}件`)
console.log(`配信停止っぽいURL・文脈        : ${dangerSeen}件`)
console.log(`そのうち誤って辿る判定にしたもの: ${dangerFollowed}件  ${dangerFollowed === 0 ? '✅' : '❌ 要修正'}`)
console.log('\n辿る先のドメイン（上位12）')
for (const [h, n] of [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${h.padEnd(38)} ${n}`)
}
process.exit(dangerFollowed === 0 ? 0 : 1)
