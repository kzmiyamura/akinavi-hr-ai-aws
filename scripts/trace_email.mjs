#!/usr/bin/env node
/**
 * trace_email.mjs — 候補者の pipeline_trace（ゾーンT台帳）を整形表示するスクリプト
 *
 * inbound-email がどのステージまで進み・どこでこけたかを一発で特定する。
 * エントリごとの最終コードが「こけた場所」。invariantViolations が空でなければ
 * どこかでサイレント失敗が起きている。
 *
 * 使い方:
 *   node scripts/trace_email.mjs <candidateId>       # 指定候補者のトレース表示
 *   node scripts/trace_email.mjs --name "F.K"        # 名前で検索して表示
 *   node scripts/trace_email.mjs --violations        # 直近14日で不変条件違反のある候補者一覧
 *   node scripts/trace_email.mjs --violations --days 7
 *
 * 環境変数（.env.local から自動読み込み）:
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です（.env.local を確認）')
  process.exit(1)
}

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase REST ${res.status}: ${await res.text()}`)
  return res.json()
}

function printTrace(cand) {
  const trace = cand.raw_profile?.pipeline_trace
  console.log(`\n━━ ${cand.name} (id=${cand.id}, created_at=${cand.created_at}) ━━`)
  if (!trace) {
    console.log('  pipeline_trace なし（ゾーンT実装前のレコード、または trace が空）')
    return
  }
  const violations = trace.invariantViolations ?? []
  if (violations.length > 0) {
    console.log(`  🚨 不変条件違反 ${violations.length}件:`)
    for (const v of violations) console.log(`     ${v}`)
  } else {
    console.log('  ✅ 不変条件違反なし')
  }
  if (trace.truncated) console.log('  （8KB上限により詳細は切り詰め済み）')
  const assigned = trace.assigned ?? {}
  if (Object.keys(assigned).length > 0) {
    console.log('  ── 本人割当エントリの台帳 ──')
    for (const [entryId, codes] of Object.entries(assigned)) {
      console.log(`  entry ${entryId}:`)
      for (const c of codes) console.log(`    ${c}`)
    }
  }
  const summary = trace.summary ?? {}
  if (Object.keys(summary).length > 0) {
    console.log('  ── メール全体サマリー（エントリごとの最終コード = こけた場所） ──')
    for (const [entryId, last] of Object.entries(summary)) {
      const mark = /FAIL|REJ|EMPTY|ERR|UNASSIGNED/.test(last) ? '⚠️ ' : '   '
      console.log(`  ${mark}entry ${entryId}: ${last}`)
    }
  }
  const emailCodes = trace.emailCodes ?? []
  if (emailCodes.length > 0) {
    console.log('  ── メール全体コード ──')
    for (const c of emailCodes) console.log(`     ${c}`)
  }
}

const args = process.argv.slice(2)
const SELECT = 'id,name,created_at,raw_profile'

if (args.includes('--violations')) {
  const daysIdx = args.indexOf('--days')
  const days = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 14
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const rows = await rest(`candidates?select=${SELECT}&created_at=gte.${since}&order=created_at.desc&limit=500`)
  const hit = rows.filter(r => (r.raw_profile?.pipeline_trace?.invariantViolations ?? []).length > 0)
  console.log(`直近${days}日: ${rows.length}件中、不変条件違反あり ${hit.length}件`)
  for (const cand of hit) printTrace(cand)
} else if (args.includes('--name')) {
  const name = args[args.indexOf('--name') + 1]
  if (!name) { console.error('--name には名前を指定してください'); process.exit(1) }
  const rows = await rest(`candidates?select=${SELECT}&name=ilike.*${encodeURIComponent(name)}*&order=created_at.desc&limit=10`)
  if (rows.length === 0) { console.log(`該当なし: ${name}`); process.exit(0) }
  for (const cand of rows) printTrace(cand)
} else if (args[0]) {
  const rows = await rest(`candidates?select=${SELECT}&id=eq.${encodeURIComponent(args[0])}`)
  if (rows.length === 0) { console.log(`該当なし: id=${args[0]}`); process.exit(0) }
  printTrace(rows[0])
} else {
  console.log('使い方: node scripts/trace_email.mjs <candidateId> | --name "F.K" | --violations [--days N]')
}
