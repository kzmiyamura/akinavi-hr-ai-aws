#!/usr/bin/env node
// cleanup_station_named.mjs — 名前が駅名そのものの候補者を検出・削除する
//
// ROSTER誤検出（最寄駅列を氏名列と誤認）で生まれたゴミ人材のクリーンアップ用。
// 目黒・横浜など駅名と同形の実在姓を守るため、「名前が駅名に完全一致」かつ
// 「experience_years が null（名簿行由来の薄いデータ）」の二重条件で絞る。
//
// 使い方:
//   node scripts/cleanup_station_named.mjs           # 検出のみ（削除しない）
//   node scripts/cleanup_station_named.mjs --apply   # 削除を実行
//   node scripts/cleanup_station_named.mjs 30        # 過去30日を対象（既定7日）
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes('--apply')
const DAYS = Number(process.argv.filter((a) => /^\d+$/.test(a))[0] ?? 7)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIONS = JSON.parse(readFileSync(join(ROOT, 'supabase/functions/inbound-email/station_data.json'), 'utf8'))

const rows = await (await fetch(
  `${URL}/rest/v1/candidates?select=id,name,experience_years,skills,created_at,from_company` +
  `&data_env=eq.prod&created_at=gte.${since}&experience_years=is.null&limit=1000`, { headers: h })).json()

const targets = rows.filter((c) => {
  const k = String(c.name ?? '').trim().replace(/駅$/, '').replace(/\s+/g, '').replace(/ヶ/g, 'ケ')
  return k && STATIONS[k]
})
console.log(`駅名人材の検出: ${targets.length}件（prod・過去${DAYS}日・経験年数null）モード=${APPLY ? '★削除' : '検出のみ'}`)
for (const c of targets) {
  console.log(` - ${c.name}（${c.from_company ?? '会社不明'}・スキル${(c.skills ?? []).length}件・${c.created_at.slice(0, 10)}）${c.id}`)
}
if (!APPLY || !targets.length) process.exit(0)

let ok = 0
for (const c of targets) {
  const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${c.id}`, { method: 'DELETE', headers: { ...h, Prefer: 'return=minimal' } })
  if (res.ok) ok++
  else console.log(`削除失敗: ${c.name} ${res.status}`)
}
console.log(`削除完了: ${ok}/${targets.length}件`)
