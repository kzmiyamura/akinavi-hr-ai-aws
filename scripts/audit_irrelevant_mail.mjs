#!/usr/bin/env node
/**
 * 無関係メール判定を**ローカル控えの全件に通して**、何が弾かれるかを確認する。
 * 本番は引かない（egress ゼロ）。
 *
 *   node scripts/audit_irrelevant_mail.mjs            # 弾かれる人材の一覧
 *   node scripts/audit_irrelevant_mail.mjs --all      # 件数だけ
 *
 * ## なぜ要るか
 *
 * 入口のフィルタは**正当な人材メールを捨てると取り返しがつかない**（メールは残らない）。
 * だから入れる前に、すでに登録済みの人材8千件に通して「何人が弾かれるか」を見る。
 * ここに出た人が全員スパム・広告なら、入れて安全という根拠になる。
 *
 * 判定は手写しせず **index.ts から切り出して**使う（companyNameGate.test.ts と同じ方式）。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARCHIVE_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))
const SHOW_ALL = process.argv.includes('--all')

function loadJudge() {
  const src = readFileSync(resolve(HERE, '../supabase/functions/inbound-email/index.ts'), 'utf8')
  const pick = (name) => {
    const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[gimsuy]*)\\r?\\n`))
    if (!m) throw new Error(`${name} を index.ts から取り出せません`)
    return m[1]
  }
  const strip = src.match(/function stripZeroWidth\(s: string\): string \{([\s\S]*?)\n\}/)
  const judge = src.match(/function irrelevantMailReason\(subject: string, body: string, hasAttachment: boolean\): string \| null \{([\s\S]*?)\n\}/)
  if (!strip || !judge) throw new Error('関数を index.ts から取り出せません')
  return new Function(`
    const ZERO_WIDTH_RE = ${pick('ZERO_WIDTH_RE')};
    const MAIL_HR_SIGNAL_RE = ${pick('MAIL_HR_SIGNAL_RE')};
    function stripZeroWidth(s) {${strip[1]}\n}
    return function (subject, body, hasAttachment) {${judge[1]}\n}
  `)()
}

const judge = loadJudge()

const dir = [join(ARCHIVE_DIR, 'db', 'candidates'), join(ARCHIVE_DIR, 'candidates')].find((d) => existsSync(d))
if (!dir) { console.error('控えが見つからない'); process.exit(1) }

const seen = new Set()
let total = 0
const hit = []
for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!r.id || seen.has(r.id) || r.data_env !== 'prod') continue
    seen.add(r.id)
    total++
    // ⚠ 控えには添付の有無が無いので hasAttachment=false で判定する。
    //    本番は添付があれば必ず通すので、**ここに出る数は実際より多めに出る**（安全側）。
    const why = judge(r.rp_subject ?? '', r.rp_text ?? '', false)
    if (why) hit.push(r)
  }
}

console.log(`控え: ${ARCHIVE_DIR}`)
console.log(`prod 人材 ${total} 件 → **弾かれる ${hit.length} 件**（${(hit.length / total * 100).toFixed(2)}%）`)
console.log('※ 控えに添付の有無が無いため hasAttachment=false で判定。本番より多めに出る（安全側）')
console.log('')
console.log('| 氏名 | 差出人 | 件名 |')
console.log('|---|---|---|')
const ZW = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u180E]/g
for (const r of (SHOW_ALL ? hit : hit.slice(0, 40))) {
  const s = String(r.rp_subject ?? '').replace(ZW, '').replace(/\|/g, '\\|').slice(0, 70)
  console.log(`| ${r.name ?? '?'} | ${r.rp_from ?? '?'} | ${s} |`)
}
if (!SHOW_ALL && hit.length > 40) console.log(`… ほか ${hit.length - 40} 件（--all で全部）`)
