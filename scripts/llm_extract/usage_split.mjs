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
// ワーカーの claude -p も同じ project ディレクトリに記録されるため、
// プロンプトの特徴語でセッションを「ワーカー」「開発（対話）」に分類する。
// これをしないと Claude Code が内部で使う haiku まで混ざり、ワーカーの消費を過大評価する
// 判定は「セッション最初のユーザーメッセージ」で行う。ワーカーは claude -p に
// 転記プロンプトを丸ごと渡すため先頭が必ずこの文言になる。
// ファイル全文で探すと、開発中にプロンプト定義ファイルを読んだ対話ログまで
// ワーカー扱いになる（最初の実装での誤り・2026-08-10）
const WORKER_SIGNATURE = /^あなたは(?:IT技術者の経歴書|SES営業)/
const firstUserText = (text) => {
  for (const line of text.split('\n')) {
    if (!line.includes('"user"')) continue
    try {
      const o = JSON.parse(line)
      if (o.type !== 'user' && o.message?.role !== 'user') continue
      const cont = o.message?.content
      const s = typeof cont === 'string' ? cont
        : Array.isArray(cont) ? (cont.find((p) => p.type === 'text')?.text ?? '') : ''
      if (s) return s.trim()
    } catch { /* 壊れた行は無視 */ }
  }
  return ''
}
const byDay = new Map()
const sessions = new Map()
const rawModels = new Map()
let files = 0, workerFiles = 0
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.jsonl')) continue
  files++
  let text
  try { text = readFileSync(join(dir, name), 'utf8') } catch { continue }
  const who = WORKER_SIGNATURE.test(firstUserText(text)) ? 'ワーカー' : '開発'
  if (who === 'ワーカー') workerFiles++
  // セッション数＝claude -p の起動回数。usage 記録は1起動で複数出るため別に数える
  {
    const m = text.match(/"timestamp":"([^"]+)"/)
    if (m && new Date(m[1]).getTime() >= sinceMs) {
      const d = jstDay(m[1])
      sessions.set(d, sessions.get(d) ?? {})
      const s = sessions.get(d)
      s[who] = (s[who] ?? 0) + 1
    }
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const u = o.message?.usage
    if (!u || !o.timestamp) continue
    const t = new Date(o.timestamp).getTime()
    if (t < sinceMs) continue
    const d = jstDay(o.timestamp)
    const rawModel = o.message.model ?? '(model不明)'
    // 実モデル名の実測（「ワーカーはhaikuと言いつつ実はopus換算では？」の検証用）
    const rk = `${who}/${rawModel}`
    rawModels.set(rk, (rawModels.get(rk) ?? 0) + 1)
    const model = /haiku/.test(rawModel) ? 'haiku'
      : /sonnet/.test(rawModel) ? 'sonnet'
        : /opus|fable/.test(rawModel) ? 'opus/fable' : 'other'
    const key = `${who}/${model}`
    if (!byDay.has(d)) byDay.set(d, {})
    const day = byDay.get(d)
    day[key] ??= { calls: 0, out: 0, inp: 0, cache: 0 }
    day[key].calls++
    day[key].out += u.output_tokens ?? 0
    day[key].inp += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    day[key].cache += u.cache_read_input_tokens ?? 0
  }
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n))
console.log(`=== Max枠の消費（ローカル記録 ${files}ファイル中ワーカー${workerFiles}・直近${DAYS}日・JST）===`)
console.log('日付        用途/モデル        呼出   出力tok   入力tok  キャッシュ読み')
for (const [d, models] of [...byDay.entries()].sort()) {
  const tot = Object.values(models).reduce((n, v) => n + v.out, 0)
  for (const [m, v] of Object.entries(models).sort((a, b) => b[1].out - a[1].out)) {
    const share = tot ? (v.out / tot * 100).toFixed(0) : '0'
    console.log(`${d}  ${m.padEnd(17)}${String(v.calls).padStart(5)}  ${k(v.out).padStart(8)}  ${k(v.inp).padStart(8)}  ${k(v.cache).padStart(12)}  出力${share}%`)
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
console.log('\n=== セッション数（claude の起動回数）===')
console.log('日付        開発  ワーカー')
for (const [d, s] of [...sessions.entries()].sort()) {
  console.log(`${d}  ${String(s['開発'] ?? 0).padStart(4)}  ${String(s['ワーカー'] ?? 0).padStart(8)}`)
}
console.log('\n=== 実際に動いたモデル（用途別・生のmodel名）===')
for (const [k, n] of [...rawModels.entries()].sort()) console.log(`  ${k.padEnd(45)} ${n}件`)
console.log('※ ワーカー行に opus/fable が無ければ、対話がOpusでもワーカーはHaiku/Sonnetで動いている')

console.log('\n※ ワーカーのセッション数 ≒ claude -p の起動回数（本文1回＋経歴書1回＋昇格1回）')
console.log('※ 1起動で usage 記録は複数出るため「呼出」列とは一致しない')
