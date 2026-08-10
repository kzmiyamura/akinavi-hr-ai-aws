#!/usr/bin/env node
// cost_per_call.mjs — 削減施策の前後で「1回あたりのコスト」がどう変わったかを測る
//
// 日次合計（usage_report.mjs）は登録数の増減に埋もれて施策の効果が見えないため、
// llm_shadow を source 別に「1回あたり」で比較する。
//
//   body       … 本文抽出。一括処理＋トリムの対象（＝効果を見たい対象）
//   attachment … 経歴書抽出。今回は未変更なので対照群（ここが動いていなければ
//                body の変化はコード変更由来と言える）
//
// 注意: 完全にスキップされた人材は llm_shadow に行が残らないため、
//       スキップ率はこの集計には出ない（ワーカーのログ行を数える必要がある）。
//
// 使い方: node scripts/llm_extract/cost_per_call.mjs <区切りISO> [日数=3]
//   例:   node scripts/llm_extract/cost_per_call.mjs 2026-08-10T05:40:00Z 3
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const CUTOFF = process.argv[2]
if (!CUTOFF || Number.isNaN(Date.parse(CUTOFF))) {
  console.error('区切りのISO時刻を渡してください 例: 2026-08-10T05:40:00Z')
  process.exit(1)
}
const cutoffMs = Date.parse(CUTOFF)
const DAYS = Number(process.argv[3] ?? 3)

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const rows = await fetchAll(
  `llm_shadow?select=candidate_id,source,model,status,cost_usd,ms,created_at&created_at=gte.${since}&order=created_at.asc`)

const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/** 成功行だけを対象に、1回あたりのコスト・時間を出す（error 行は cost が入らないため別数え） */
function stat(list) {
  const ok = list.filter((r) => r.status !== 'error')
  const costs = ok.map((r) => r.cost_usd ?? 0)
  const total = costs.reduce((n, v) => n + v, 0)
  return {
    calls: ok.length,
    errors: list.length - ok.length,
    total,
    mean: ok.length ? total / ok.length : 0,
    med: median(costs),
    medMs: median(ok.map((r) => r.ms ?? 0)),
    sonnet: ok.filter((r) => r.model === 'sonnet').length,
  }
}

const fmt = (label, s) =>
  `${label.padEnd(6)} ${String(s.calls).padStart(5)}回 ${String(s.errors).padStart(4)}件  ` +
  `$${s.mean.toFixed(4)}  $${s.med.toFixed(4)}  ${(s.medMs / 1000).toFixed(1)}秒  ` +
  `$${s.total.toFixed(2).padStart(7)}  昇格${s.sonnet}`

console.log(`=== 1回あたりコスト 前後比較（区切り ${CUTOFF} / 直近${DAYS}日 / llm_shadow ${rows.length}行）===`)
console.log('※API換算の参考値。Maxサブスク枠のため実課金ではない\n')

for (const source of ['body', 'attachment']) {
  const mine = rows.filter((r) => r.source === source)
  const before = stat(mine.filter((r) => Date.parse(r.created_at) < cutoffMs))
  const after = stat(mine.filter((r) => Date.parse(r.created_at) >= cutoffMs))
  const note = source === 'body' ? '（削減対象）' : '（対照群・未変更）'
  console.log(`--- source=${source} ${note} ---`)
  console.log('       呼出   エラー  平均$/回  中央$/回  中央時間     合計$  昇格')
  console.log(fmt('変更前', before))
  console.log(fmt('変更後', after))
  if (before.calls && after.calls) {
    const d = (1 - after.mean / before.mean) * 100
    console.log(`  → 平均 ${d >= 0 ? '▼' : '▲'}${Math.abs(d).toFixed(0)}%` +
      `（$${before.mean.toFixed(4)} → $${after.mean.toFixed(4)}）`)
  } else {
    console.log(`  → 比較不可（変更前${before.calls}回 / 変更後${after.calls}回。サンプルが溜まるまで待つ）`)
  }
  console.log()
}
