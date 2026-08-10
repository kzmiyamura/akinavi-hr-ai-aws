#!/usr/bin/env node
// roster_origin_report.mjs — 名簿(ROSTER)展開由来の人材が実際どれだけ有用かを測る
//
// 「名簿の取り扱いをやめるべきか」を感覚でなくデータで判断するための計測ツール。
// 名簿由来の印: attachmentNames が "ファイル名#行名" 形式（rosterRowName 付き）。
// 有用判定: 人の属性（年齢/性別/単価）が1つ以上あり、スキルも取れている。
//
// 使い方: node scripts/roster_origin_report.mjs [日数=14]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const DAYS = Number(process.argv[2] ?? 14)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const rows = []
for (let from = 0; ; from += 1000) {
  const q = `candidates?select=id,name,created_at,desired_rate,experience_years,skills,` +
    `att:raw_profile->>attachmentNames,age:raw_profile->age,gender:raw_profile->>gender,` +
    `station:raw_profile->>nearestStation` +
    `&data_env=eq.prod&created_at=gte.${since}&order=created_at.asc&limit=1000&offset=${from}`
  const res = await fetch(`${URL}/rest/v1/${q}`, { headers: h })
  if (!res.ok) { console.error(`取得失敗 ${res.status}`); process.exit(1) }
  const page = await res.json()
  rows.push(...page)
  if (page.length < 1000) break
}

// 名簿由来 = 添付ラベルに "#行名" が付いている（rosterRowName 由来）
const isRoster = (c) => /#/.test(String(c.att ?? ''))
// 人として使える = 人の属性が1つ以上 かつ スキルが1件以上
const isUseful = (c) =>
  (c.age != null || c.gender || c.desired_rate) && (c.skills ?? []).length > 0

const roster = rows.filter(isRoster)
const useful = roster.filter(isUseful)
const junk = roster.filter((c) => !isUseful(c))

console.log(`=== 名簿由来人材の有用性（prod・直近${DAYS}日・全${rows.length}件）===`)
console.log(`名簿由来:      ${roster.length}件（全体の ${(roster.length / Math.max(rows.length, 1) * 100).toFixed(1)}%）`)
console.log(`  └ 使える:    ${useful.length}件（人の属性＋スキルあり）`)
console.log(`  └ 使えない:  ${junk.length}件（属性なし＝幽霊の疑い）`)
console.log(`本文由来など:  ${rows.length - roster.length}件`)

const sample = (arr, n = 8) => arr.slice(-n).map((c) => `${c.name}(${(c.skills ?? []).length}sk)`).join(', ')
if (useful.length) console.log(`\n使える例: ${sample(useful)}`)
if (junk.length) console.log(`使えない例: ${sample(junk)}`)
