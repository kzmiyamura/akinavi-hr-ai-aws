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
const shadow = await fetchAll(`llm_shadow?select=candidate_id,created_at,model,source,status,cost_usd,ms&created_at=gte.${since}&order=created_at.asc`)
const byDay = new Map()
for (const r of shadow) {
  const d = jstDay(r.created_at)
  if (!byDay.has(d)) byDay.set(d, { haiku: 0, sonnet: 0, haikuCost: 0, sonnetCost: 0, error: 0, ms: 0 })
  const v = byDay.get(d)
  v.ms += r.ms ?? 0
  if (r.status === 'error') { v.error++; continue }
  // 注: 昇格時は model='sonnet' で cost_usd に haiku+sonnet の合算が入る
  if (r.model === 'sonnet') { v.sonnet++; v.sonnetCost += r.cost_usd ?? 0 }
  else { v.haiku++; v.haikuCost += r.cost_usd ?? 0 }
}
console.log(`=== LLM呼び出し 日別（JST・直近${DAYS}日・llm_shadow由来）===`)
console.log('日付        haiku件  sonnet件(昇格)  エラー  API換算コスト  実処理時間')
let tH = 0, tS = 0, tC = 0, tMs = 0
for (const [d, v] of [...byDay.entries()].sort()) {
  tH += v.haiku; tS += v.sonnet; tC += v.haikuCost + v.sonnetCost; tMs += v.ms
  console.log(`${d}  ${String(v.haiku).padStart(6)}  ${String(v.sonnet).padStart(12)}  ${String(v.error).padStart(5)}  $${(v.haikuCost + v.sonnetCost).toFixed(2).padStart(7)}  ${(v.ms / 3600000).toFixed(2)}h`)
}
console.log(`合計        ${String(tH).padStart(6)}  ${String(tS).padStart(12)}         $${tC.toFixed(2)}  ${(tMs / 3600000).toFixed(2)}h`)
console.log('※API換算は参考値。Maxサブスク枠のため実課金ではない')
console.log('※実処理時間 = claude -p がモデルを回していた実測の壁時計時間（週次上限の目安）')

// ── 5時間枠あたりの占有率（Max の5時間制限に対する目安）──
// Max の5時間制限はトークン/メッセージ量で管理されており時間そのものではないため、
// ここで出すのは「5時間のうちモデルを回していた時間の割合」＝連続稼働の目安。
// 上限そのものの使用率は Claude Code の /usage が唯一の正解。
{
  const W = 5 * 3600 * 1000
  const rows = shadow.filter((r) => r.ms).map((r) => ({ t: new Date(r.created_at).getTime(), ms: r.ms, model: r.model }))
  rows.sort((a, b) => a.t - b.t)
  let lo = 0, sum = 0, sumS = 0, best = { ms: 0, sonnetMs: 0, at: null }
  for (let hi = 0; hi < rows.length; hi++) {
    sum += rows[hi].ms
    if (rows[hi].model === 'sonnet') sumS += rows[hi].ms
    while (rows[lo].t < rows[hi].t - W) { sum -= rows[lo].ms; if (rows[lo].model === 'sonnet') sumS -= rows[lo].ms; lo++ }
    if (sum > best.ms) best = { ms: sum, sonnetMs: sumS, at: new Date(rows[hi].t).toISOString() }
  }
  // 直近5時間
  const now = Date.now()
  const recent = rows.filter((r) => r.t >= now - W)
  const recentMs = recent.reduce((n, r) => n + r.ms, 0)
  const recentS = recent.filter((r) => r.model === 'sonnet').reduce((n, r) => n + r.ms, 0)
  const pct = (ms) => `${(ms / W * 100).toFixed(1)}%`
  console.log(`\n=== 5時間枠あたりのモデル稼働（ワーカー分のみ）===`)
  console.log(`ピーク5時間: ${(best.ms / 3600000).toFixed(2)}時間 = 枠の ${pct(best.ms)}` +
    `（うちsonnet ${(best.sonnetMs / 3600000).toFixed(2)}時間）${best.at ? ' 終了時刻 ' + best.at : ''}`)
  console.log(`直近5時間:   ${(recentMs / 3600000).toFixed(2)}時間 = 枠の ${pct(recentMs)}` +
    `（うちsonnet ${(recentS / 3600000).toFixed(2)}時間）`)
  console.log('※Maxの5時間制限はトークン量で管理されており時間ではない。正確な使用率は /usage を参照')
}

// ── 週次（直近7日）の実処理時間 ──
const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
let weekMs = 0, weekCalls = 0
for (const r of shadow) {
  if (new Date(r.created_at).getTime() < weekAgo) continue
  weekMs += r.ms ?? 0
  weekCalls++
}
console.log(`\n直近7日の実処理時間: ${(weekMs / 3600000).toFixed(2)}時間（${weekCalls}回・ワーカー分のみ）`)

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
