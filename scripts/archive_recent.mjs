#!/usr/bin/env node
/**
 * ローカル控えから「直近の取り込み状況」を時間別に出す。**本番は引かない。**
 *
 *   node scripts/archive_recent.mjs [日数]
 *
 * poll-email が動いているか、いつ何件処理したかを、egress ゼロで確認するためのもの。
 * 削除済みフォルダに何日ぶん残るかを見積もるのにも使う
 * （処理した件数＝Outlook 側で削除された件数）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ARCHIVE_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))
const days = Number(process.argv[2] ?? 3)
const since = new Date(Date.now() - days * 86400000).toISOString()

function* rows(table) {
  const dir = join(ARCHIVE_DIR, table)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

/** JST の「MM/DD HH時」に丸める（運用はJSTで見るため） */
function jstHour(iso) {
  const d = new Date(iso)
  const j = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}時`
}

const byHour = new Map()
const bump = (h, key) => {
  const a = byHour.get(h) ?? { mail: 0, cand: 0, attach: 0 }
  a[key]++
  byHour.set(h, a)
}

for (const r of rows('ai_logs')) {
  if (!r.created_at || r.created_at < since) continue
  const h = jstHour(r.created_at)
  if (r.type === 'candidate') bump(h, 'mail')
  if (r.type === 'poll-attach') bump(h, 'attach')
}
for (const r of rows('candidates')) {
  if (!r.created_at || r.created_at < since) continue
  bump(jstHour(r.created_at), 'cand')
}

console.log(`控え: ${ARCHIVE_DIR}（直近 ${days} 日・JST）\n`)
console.log('時刻            人材メール  登録    添付あり')
const keys = [...byHour.keys()].sort()
for (const h of keys) {
  const a = byHour.get(h)
  console.log(`${h}  ${String(a.mail).padStart(8)}  ${String(a.cand).padStart(5)}  ${String(a.attach).padStart(6)}`)
}
if (keys.length === 0) console.log('（この期間の記録がありません）')

const total = [...byHour.values()].reduce((s, a) => s + a.mail, 0)
console.log(`\n合計 人材メール ${total} 件 = Outlook 側で削除された件数の目安`)
console.log('控えの最終取得より後は入っていません。最新を見るなら先に archive_local.mjs を回すこと')
