#!/usr/bin/env node
/**
 * 厚労省の人材サービス総合サイトの詳細ページで、**各項目がどれだけ記入されているか**を測る。
 *
 *   node scripts/mhlw_field_coverage.mjs --limit 30
 *   node scripts/mhlw_field_coverage.mjs --limit 30 --out <json>
 *
 * ## なぜ測るのか
 *
 * 詳細ページには「得意とする職種」「派遣労働者数」「派遣料金の平均額」
 * 「派遣労働者の賃金の平均額」「マージン率」といった、**営業に効く情報**の欄がある。
 * ただし**記入は義務の度合いがまちまちで、空欄のことが多い**（株式会社GFD は全部空だった）。
 *
 * 空欄だらけの項目を前提に画面や採点を作ると無駄になるので、**作る前に記入率を測る**。
 *
 * 対象は `agent_companies` の控えにある `haken_detail_url`（本番は引かない）。
 * 外部サイトへのアクセスなので件数を絞り、1件ずつ間隔を空ける。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ARCHIVE_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d }
const LIMIT = Number(flag('--limit', '30'))
const WAIT_MS = Number(flag('--wait', '1200'))
const OUT = flag('--out', null)

/** 測る項目。ページの見出し文字列そのまま */
const FIELDS = [
  '事業主名称', '事業所名称', '事業所所在地', '電話番号',
  '得意とする職種',
  '派遣労働者数',
  '労働者派遣の役務の提供を受けた者の数',
  '派遣料金の平均額',
  '派遣労働者の賃金の平均額',
  'マージン率',
  '労使協定の締結',
  '派遣労働者のキャリア形成支援制度に関する事項',
]

const p = [
  join(ARCHIVE_DIR, 'db', 'masters', 'agent_companies.jsonl'),
  join(ARCHIVE_DIR, 'masters', 'agent_companies.jsonl'),
].find((x) => existsSync(x))
if (!p) { console.error('agent_companies の控えが無い'); process.exit(1) }

const rows = []
for (const line of readFileSync(p, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const r = JSON.parse(line)
    if (r.haken_detail_url) rows.push(r)
  } catch { /* 壊れた行は飛ばす */ }
}
console.log(`詳細URLを持つ会社 ${rows.length} 社 → 先頭 ${Math.min(LIMIT, rows.length)} 社を見る`)
console.log('')

/** 見出し → 値 のテーブルを素朴に剥がす。値が空白のみなら未記入とみなす */
function parseFields(html) {
  const text = html.replace(/\r/g, '')
  const out = {}
  for (const f of FIELDS) {
    // <td>見出し</td> ... <td>値</td> を拾う。セル内のタグは落とす
    const re = new RegExp(`${f.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]{0,400}?<\\/t[dh]>([\\s\\S]{0,800}?)<\\/t[dr]>`, 'i')
    const m = text.match(re)
    if (!m) { out[f] = null; continue }
    const v = m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    out[f] = v
  }
  return out
}

const filled = new Map(FIELDS.map((f) => [f, 0]))
const samples = new Map(FIELDS.map((f) => [f, []]))
let ok = 0, fail = 0
const results = []

for (const r of rows.slice(0, LIMIT)) {
  try {
    const res = await fetch(r.haken_detail_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AkiNavi-audit/1.0)' },
    })
    if (!res.ok) { fail++; continue }
    const html = await res.text()
    const f = parseFields(html)
    ok++
    for (const k of FIELDS) {
      const v = f[k]
      if (v && v.length > 0) {
        filled.set(k, filled.get(k) + 1)
        const s = samples.get(k)
        if (s.length < 3) s.push(`${r.company_name}: ${v.slice(0, 60)}`)
      }
    }
    results.push({ domain: r.domain, company: r.company_name, fields: f })
  } catch (e) {
    fail++
  }
  await new Promise((r) => setTimeout(r, WAIT_MS))
}

console.log(`取得成功 ${ok} 社 / 失敗 ${fail} 社`)
console.log('')
console.log('| 項目 | 記入あり | 記入率 |')
console.log('|---|---:|---:|')
for (const f of FIELDS) {
  const n = filled.get(f)
  console.log(`| ${f} | ${n} | ${ok ? ((n / ok) * 100).toFixed(0) : 0}% |`)
}
console.log('')
for (const f of FIELDS) {
  const s = samples.get(f)
  if (s.length > 0 && !['事業主名称', '事業所名称', '事業所所在地', '電話番号'].includes(f)) {
    console.log(`■ ${f}`)
    for (const x of s) console.log(`   ${x}`)
  }
}

if (OUT) {
  writeFileSync(resolve(OUT), JSON.stringify(results, null, 2), 'utf8')
  console.log(`\nJSON: ${resolve(OUT)}`)
}
