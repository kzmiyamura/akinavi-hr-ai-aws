#!/usr/bin/env node
// usage_report.mjs — LLM消費量（haiku/sonnet）と補正レイテンシの日次レポート
//
// - llm_shadow の cost_usd/model を JST 日別に集計（※API換算の参考値。Maxサブスク枠なので実課金ではない）
// - 案件サイクルは llm_shadow に記録されないため、参考として candidates 登録数と
//   「登録→LLM補正完了」の実測レイテンシも出す
//
// 使い方: node scripts/llm_extract/usage_report.mjs [日数=7]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const DAYS = Number(process.argv[2] ?? 7)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const jstDay = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`, { headers: h })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// ── LLM呼び出し集計（llm_shadow）──
const shadow = await fetchAll(`llm_shadow?select=candidate_id,created_at,model,source,status,cost_usd&created_at=gte.${since}&order=created_at.asc`)
const byDay = new Map()
for (const r of shadow) {
  const d = jstDay(r.created_at)
  if (!byDay.has(d)) byDay.set(d, { haiku: 0, sonnet: 0, haikuCost: 0, sonnetCost: 0, error: 0 })
  const v = byDay.get(d)
  if (r.status === 'error') { v.error++; continue }
  // 注: 昇格時は model='sonnet' で cost_usd に haiku+sonnet の合算が入る
  if (r.model === 'sonnet') { v.sonnet++; v.sonnetCost += r.cost_usd ?? 0 }
  else { v.haiku++; v.haikuCost += r.cost_usd ?? 0 }
}
console.log(`=== LLM呼び出し 日別（JST・直近${DAYS}日・llm_shadow由来）===`)
console.log('日付        haiku件  sonnet件(昇格)  エラー  API換算コスト')
let tH = 0, tS = 0, tC = 0
for (const [d, v] of [...byDay.entries()].sort()) {
  tH += v.haiku; tS += v.sonnet; tC += v.haikuCost + v.sonnetCost
  console.log(`${d}  ${String(v.haiku).padStart(6)}  ${String(v.sonnet).padStart(12)}  ${String(v.error).padStart(5)}  $${(v.haikuCost + v.sonnetCost).toFixed(2)}`)
}
console.log(`合計        ${String(tH).padStart(6)}  ${String(tS).padStart(12)}         $${tC.toFixed(2)}`)
console.log('※Maxサブスク枠のため実課金ではない参考値。案件サイクル分は含まず（下記参照）')

// ── 登録数と補正レイテンシ（candidates）──
const cands = await fetchAll(
  `candidates?select=id,created_at,ap:raw_profile->_llm_applied->>at&data_env=eq.prod&created_at=gte.${since}&order=created_at.asc`)
const dayCand = new Map()
const lat = []
for (const c of cands) {
  const d = jstDay(c.created_at)
  dayCand.set(d, (dayCand.get(d) ?? 0) + 1)
  if (c.ap) {
    const ms = new Date(c.ap) - new Date(c.created_at)
    if (ms > 0 && ms < 24 * 3600 * 1000) lat.push(ms / 60000)
  }
}
// ── カバー率: 登録された人材のうち実際にLLM処理まで届いた割合 ──
// 消費量そのものより「取りこぼしなく校正できているか」が運用上の本題。
// llm_shadow に1行でもあれば処理済み（変更なしで終わった人も処理済みに数える）
const processed = new Set(shadow.map((r) => r.candidate_id))
const dayCovered = new Map()
for (const c of cands) {
  const d = jstDay(c.created_at)
  if (processed.has(c.id)) dayCovered.set(d, (dayCovered.get(d) ?? 0) + 1)
}
console.log(`\n=== prod 人材登録数とAI校正カバー率 日別 ===`)
console.log('日付        登録数   校正済み   カバー率')
for (const [d, n] of [...dayCand.entries()].sort()) {
  const cov = dayCovered.get(d) ?? 0
  console.log(`${d}  ${String(n).padStart(6)}  ${String(cov).padStart(8)}   ${(cov / n * 100).toFixed(1)}%`)
}
if (lat.length) {
  lat.sort((a, b) => a - b)
  const p = (q) => lat[Math.floor(lat.length * q)].toFixed(1)
  console.log(`\n=== 登録→LLM補正完了レイテンシ（実測 ${lat.length}件）===`)
  console.log(`中央値 ${p(0.5)}分 / 75%タイル ${p(0.75)}分 / 90%タイル ${p(0.9)}分 / 最大 ${lat[lat.length - 1].toFixed(0)}分`)
}
