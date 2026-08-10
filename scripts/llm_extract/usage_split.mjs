#!/usr/bin/env node
// usage_split.mjs — Max枠の消費を「開発（対話）」と「ワーカー（常駐AI）」に分けて集計する
//
// 同じ Max 枠を2つの用途が食い合うため、どちらがどれだけ使っているか分からないと
// 並列度を上げてよいか判断できない。両方を同じ土俵（トークン数）で並べる。
//
//   開発分  : ~/.claude/projects/<project>/*.jsonl の message.usage（対話・サブエージェント含む）
//   ワーカー: 同じ記録のうち claude -p 由来のセッション。cwd が同じでも起動元が異なるため
//             ワーカーは llm_shadow（実行回数・実処理時間）で別途集計して突き合わせる
//
// 使い方: node scripts/llm_extract/usage_split.mjs [日数=3]
import { readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DAYS = Number(process.argv[2] ?? 3)
const sinceMs = Date.now() - DAYS * 24 * 3600 * 1000
const jstDay = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10)

// ── ① ローカル記録からトークンを集計（モデル別・日別）──
const dir = join(homedir(), '.claude/projects/C--Users-admin-Desktop-projects-akinavi-hr-ai-aws')
const byDay = new Map()
let files = 0
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.jsonl')) continue
  files++
  let text
  try { text = readFileSync(join(dir, name), 'utf8') } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const u = o.message?.usage
    if (!u || !o.timestamp) continue
    const t = new Date(o.timestamp).getTime()
    if (t < sinceMs) continue
    const d = jstDay(o.timestamp)
    const model = /haiku/.test(o.message.model ?? '') ? 'haiku'
      : /sonnet/.test(o.message.model ?? '') ? 'sonnet'
        : /opus|fable/.test(o.message.model ?? '') ? 'opus/fable' : 'other'
    if (!byDay.has(d)) byDay.set(d, {})
    const day = byDay.get(d)
    day[model] ??= { calls: 0, out: 0, inp: 0, cache: 0 }
    day[model].calls++
    day[model].out += u.output_tokens ?? 0
    day[model].inp += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    day[model].cache += u.cache_read_input_tokens ?? 0
  }
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n))
console.log(`=== Max枠の消費（ローカル記録 ${files}ファイル・直近${DAYS}日・JST）===`)
console.log('日付        モデル       呼出   出力tok   入力tok  キャッシュ読み')
for (const [d, models] of [...byDay.entries()].sort()) {
  for (const [m, v] of Object.entries(models).sort((a, b) => b[1].out - a[1].out)) {
    console.log(`${d}  ${m.padEnd(11)}${String(v.calls).padStart(5)}  ${k(v.out).padStart(8)}  ${k(v.inp).padStart(8)}  ${k(v.cache).padStart(12)}`)
  }
}

// ── ② ワーカーの実績（llm_shadow）と突き合わせ ──
for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const since = new Date(sinceMs).toISOString()
const shadow = await (await fetch(
  `${URL}/rest/v1/llm_shadow?select=model,ms,created_at,status&created_at=gte.${since}&limit=5000`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json()

const wDay = new Map()
for (const r of shadow) {
  const d = jstDay(r.created_at)
  if (!wDay.has(d)) wDay.set(d, { haiku: 0, sonnet: 0, ms: 0 })
  const v = wDay.get(d)
  v.ms += r.ms ?? 0
  if (r.status !== 'error') v[r.model === 'sonnet' ? 'sonnet' : 'haiku']++
}
console.log(`\n=== ワーカー（常駐AI）の実績 ===`)
console.log('日付        haiku  sonnet  実処理時間')
for (const [d, v] of [...wDay.entries()].sort()) {
  console.log(`${d}  ${String(v.haiku).padStart(5)}  ${String(v.sonnet).padStart(6)}  ${(v.ms / 3600000).toFixed(2)}h`)
}
console.log('\n※ ローカル記録の出力tok が「開発（対話）＋ワーカー」の合計。')
console.log('※ ワーカーは claude -p で1回あたり数千tok程度。出力tokの大半が opus/fable なら開発分が支配的。')
