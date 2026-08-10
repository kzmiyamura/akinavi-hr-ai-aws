#!/usr/bin/env node
// close_issues_bulk.mjs — 同種の Issue をまとめてコメント＋クローズする
//
// 自動通知が乱立したときの後片付け用。タイトルの部分一致で対象を絞る。
//
// 使い方:
//   node scripts/close_issues_bulk.mjs "非人材検知" --comment-file <path>
//   node scripts/close_issues_bulk.mjs "非人材検知" --comment "本文"   # 短文用
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(ROOT, '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    const eq = t.indexOf('=')
    if (!t || t.startsWith('#') || eq < 0) continue
    if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
}
const EDGE = `${process.env.VITE_SUPABASE_URL}/functions/v1/create-github-issue`
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const args = process.argv.slice(2)
const match = args[0]
const ci = args.indexOf('--comment'), cfi = args.indexOf('--comment-file')
const comment = ci >= 0 ? args[ci + 1] : cfi >= 0 ? readFileSync(args[cfi + 1], 'utf-8') : undefined
if (!match || !comment) { console.error('使い方: node scripts/close_issues_bulk.mjs "<タイトル部分一致>" --comment-file <path>'); process.exit(1) }

const all = await (await fetch(EDGE, { headers: { Authorization: `Bearer ${KEY}` } })).json()
const targets = all.filter((i) => i.state === 'open' && String(i.title).includes(match))
console.log(`対象: ${targets.length}件（タイトルに「${match}」を含む open Issue）`)
let ok = 0
for (const it of targets) {
  const res = await fetch(EDGE, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: it.number, comment, state: 'closed' }),
  })
  if (res.ok) { ok++; console.log(`  ✅ #${it.number}`) }
  else console.log(`  ❌ #${it.number} ${res.status}`)
}
console.log(`完了: ${ok}/${targets.length}件`)
