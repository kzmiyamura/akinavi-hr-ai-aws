#!/usr/bin/env node
/**
 * 「Storage から落とさずローカル控えで足りるか」を命中率で測る（2026-09-26）。
 *
 * 引くのは resume_url 1列だけ（1件約130バイト）。本文も raw_profile も引かない。
 * これで月1GB の egress を止められるかが決まるので、この一回は測る価値がある。
 *
 * 実行: node scripts/llm_extract/measure_local_resume_hits.mjs [--days 7]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_PATH = join(homedir(), '.akinavi_shadow.env')
const INDEX_PATH = 'D:/akinavi-archive/mail/_resume_index.json'

function loadEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const env = loadEnv(ENV_PATH)
const URL_BASE = env.SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_KEY
if (!URL_BASE || !KEY) { console.error('env に SUPABASE_URL / SUPABASE_SERVICE_KEY がありません'); process.exit(1) }

const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 7
const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
console.log(`ローカル索引: ${Object.keys(index).length} 件`)

const since = new Date(Date.now() - days * 86400000).toISOString()
// PostgREST は1000行で黙って切るので明示的にページングする
const urls = []
for (let offset = 0; ; offset += 1000) {
  const q = `${URL_BASE}/rest/v1/candidates?select=resume_url,created_at,drive_url,box_url` +
    `&data_env=eq.prod&merged_into=is.null&resume_url=not.is.null` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc&limit=1000&offset=${offset}`
  const res = await fetch(q, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1) }
  const rows = await res.json()
  urls.push(...rows)
  if (rows.length < 1000) break
}
console.log(`直近${days}日の経歴書つき人材: ${urls.length} 件（転送 約${Math.round(urls.join('').length / 1024)}KB）`)

// Storage 名は `{名前}_{sha256(base64) の先頭20桁}.{拡張子}`
const HASH_RE = /_([0-9a-f]{20})\.[A-Za-z0-9]+$/
let hit = 0, miss = 0, noHash = 0
const uniq = new Set(), uniqHit = new Set()
const missSample = []
const byDay = new Map()
let missWithLink = 0
for (const r of urls) {
  const u = r.resume_url
  const day = (r.created_at || '').slice(0, 10)
  const m = decodeURIComponent(u || '').match(HASH_RE)
  if (!m) { noHash++; continue }
  uniq.add(m[1])
  const d = byDay.get(day) || { hit: 0, miss: 0 }
  // Drive/Box から落として Storage に入れたものは、そもそもメール添付ではない＝控えに無くて当然
  if (index[m[1]]) { hit++; uniqHit.add(m[1]); d.hit++ }
  else {
    miss++; d.miss++
    if (r.drive_url || r.box_url) missWithLink++
    if (missSample.length < 5) missSample.push(decodeURIComponent(u).split('/').pop())
  }
  byDay.set(day, d)
}

const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—'
console.log('')
console.log(`ローカルにある   : ${hit} 件 (${pct(hit, hit + miss)})`)
console.log(`ローカルに無い   : ${miss} 件 (${pct(miss, hit + miss)})`)
console.log(`名前が想定外     : ${noHash} 件`)
console.log(`実ファイル数     : ${uniq.size} 件（うちローカルにある ${uniqHit.size} 件）`)
console.log(`無いうちDrive/Box由来: ${missWithLink} 件（メール添付ではないので控えに無くて当然）`)
// 控えは15分おき、ワーカーは新しい順に処理する。
// 「控える前に処理してしまう」競合が起きていれば、新しい人ほど命中率が落ちるはず。
console.log('')
console.log('登録からの経過時間ごとの命中率（控えとの競合を見る）:')
const AGE_BUCKETS = [
  ['0〜30分', 0, 0.5], ['30分〜1時間', 0.5, 1], ['1〜2時間', 1, 2],
  ['2〜6時間', 2, 6], ['6〜24時間', 6, 24], ['1日以上', 24, Infinity],
]
for (const [label, lo, hi] of AGE_BUCKETS) {
  let h = 0, t = 0
  for (const r of urls) {
    const ageH = (Date.now() - new Date(r.created_at).getTime()) / 3600000
    if (ageH < lo || ageH >= hi) continue
    const m = decodeURIComponent(r.resume_url || '').match(HASH_RE)
    if (!m) continue
    t++; if (index[m[1]]) h++
  }
  if (t) console.log(`  ${label.padEnd(12)} ${String(h).padStart(4)}/${String(t).padStart(4)}  ${pct(h, t).padStart(6)}`)
}

console.log('')
console.log('登録日ごとの命中率:')
for (const [day, d] of [...byDay].sort()) {
  const t = d.hit + d.miss
  console.log(`  ${day}  ${String(d.hit).padStart(4)}/${String(t).padStart(4)}  ${pct(d.hit, t).padStart(6)}`)
}
console.log('')
console.log(`止められる転送   : 約 ${Math.round(hit * 156 / 1024)}MB / ${days}日 ＝ 月 ${(hit * 156 / 1024 / days * 30 / 1024).toFixed(2)}GB`)
if (missSample.length) {
  console.log('')
  console.log('ローカルに無い例:')
  for (const s of missSample) console.log(`  ${s}`)
}
