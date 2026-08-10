#!/usr/bin/env node
// fix_unai_fields.mjs — 監査で見つかった既存データの誤値を是正する
//
// 対象（AI校正の対象外で誰にも直されないフィールド）:
//   ① 国籍が国名でない（上記人 / 1人 / 全国 等）→ null にする
//   ② 最寄駅から都道府県が引けるのに矛盾 or 空 → 駅由来の都道府県に是正
// 判定ロジックは inbound-email / apply.mjs と同じものを使う。
//
// 使い方:
//   node scripts/fix_unai_fields.mjs [日数=7]           # 検出のみ
//   node scripts/fix_unai_fields.mjs [日数] --apply     # 是正を実行
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { prefectureFromStation } from './llm_extract/apply.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes('--apply')
const DAYS = Number(process.argv.filter((a) => /^\d+$/.test(a))[0] ?? 7)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const { isValidNationality } = await import('./_extractors.gen.mjs')

const rows = []
for (let from = 0; ; from += 500) {
  const q = `candidates?select=id,name,raw_profile&data_env=eq.prod&merged_into=is.null` +
    `&created_at=gte.${since}&order=created_at.desc&limit=500&offset=${from}`
  const res = await fetch(`${URL}/rest/v1/${q}`, { headers: h })
  if (!res.ok) { console.error(`取得失敗 ${res.status}`); process.exit(1) }
  const page = await res.json()
  rows.push(...page)
  if (page.length < 500) break
}

const plans = []
for (const c of rows) {
  const rp = c.raw_profile ?? {}
  const changes = []
  const next = { ...rp }
  if (rp.nationality && !isValidNationality(String(rp.nationality))) {
    next.nationality = null
    changes.push(`国籍 "${rp.nationality}" → null`)
  }
  const p = prefectureFromStation(rp.nearestStation)
  if (p && p !== rp.prefecture) {
    next.prefecture = p
    changes.push(`都道府県 ${rp.prefecture ?? '(空)'} → ${p}（${rp.nearestStation}）`)
  }
  if (changes.length) plans.push({ c, next, changes })
}

console.log(`=== 既存データの是正（prod・直近${DAYS}日・${rows.length}件）モード=${APPLY ? '★適用' : '検出のみ'} ===`)
console.log(`対象: ${plans.length}件`)
for (const p of plans.slice(0, 10)) console.log(`  ${p.c.name}: ${p.changes.join(' / ')}`)
if (plans.length > 10) console.log(`  …ほか ${plans.length - 10}件`)
if (!APPLY || !plans.length) { console.log(`\n（--apply で ${plans.length}件を是正）`); process.exit(0) }

let ok = 0
for (const p of plans) {
  const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${p.c.id}`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: p.next }),
  })
  if (res.ok) ok++
  else console.log(`  失敗: ${p.c.name} ${res.status}`)
}
console.log(`\n是正完了: ${ok}/${plans.length}件`)
