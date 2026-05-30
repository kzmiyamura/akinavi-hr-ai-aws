#!/usr/bin/env node
/**
 * fetch_logs.mjs — Supabase Edge Function ログをターミナルで取得
 *
 * 使い方:
 *   node scripts/fetch_logs.mjs "[Word]"                # キーワード検索
 *   node scripts/fetch_logs.mjs "station_unmapped"      # 未マッピング駅
 *   node scripts/fetch_logs.mjs "[skill_master]"        # スキル照合ログ
 *   node scripts/fetch_logs.mjs --hours 48 "[Word]"     # 直近48時間
 *   node scripts/fetch_logs.mjs --limit 100 "ERROR"     # 最大100件
 *   node scripts/fetch_logs.mjs --raw "[Word]"          # JSON生データ表示
 *
 * 環境変数（.env.local から自動読み込み）:
 *   SUPABASE_ACCESS_TOKEN   必須（Supabase Dashboard > Account > Access Tokens）
 *   VITE_SUPABASE_URL       必須（プロジェクトURL）
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
    const val = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const PROJECT_REF = SUPABASE_URL?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]

if (!ACCESS_TOKEN) {
  console.error('ERROR: SUPABASE_ACCESS_TOKEN が未設定です')
  console.error('  取得先: https://supabase.com/dashboard/account/tokens')
  console.error('  設定方法: .env.local に SUPABASE_ACCESS_TOKEN=sbp_xxxx を追加')
  process.exit(1)
}
if (!PROJECT_REF) {
  console.error('ERROR: VITE_SUPABASE_URL が未設定です')
  process.exit(1)
}

// --- CLI 引数 ---
const args = process.argv.slice(2)
const HOURS = parseInt(args.find((_, i) => args[i - 1] === '--hours') ?? '24')
const LIMIT = parseInt(args.find((_, i) => args[i - 1] === '--limit') ?? '200')
const RAW = args.includes('--raw')
const QUERY = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--hours' && args[args.indexOf(a) - 1] !== '--limit').join(' ').trim()

if (!QUERY) {
  console.error('使い方: node scripts/fetch_logs.mjs [--hours N] [--limit N] [--raw] "<検索キーワード>"')
  process.exit(1)
}

// --- ログ取得 ---
async function fetchLogs(query, hours, limit) {
  const end = new Date()
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
  const params = new URLSearchParams({
    product: 'edge-runtime',
    q: query,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
    limit: String(limit),
  })
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?${params}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Management API ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.result ?? []
}

// --- メイン ---
console.log(`\n🔍 Edge Function ログ取得`)
console.log(`   キーワード : "${QUERY}"`)
console.log(`   期間       : 直近 ${HOURS} 時間`)
console.log(`   上限       : ${LIMIT} 件\n`)

try {
  const logs = await fetchLogs(QUERY, HOURS, LIMIT)

  if (logs.length === 0) {
    console.log('該当ログなし')
    process.exit(0)
  }

  console.log(`${logs.length} 件ヒット${logs.length >= LIMIT ? '（上限到達・--limit で増加可）' : ''}\n`)
  console.log('─'.repeat(70))

  if (RAW) {
    console.log(JSON.stringify(logs, null, 2))
  } else {
    for (const log of logs) {
      const ts = log.timestamp
        ? new Date(log.timestamp / 1000).toISOString().replace('T', ' ').slice(0, 19)
        : '?'
      const level = (log.metadata?.[0]?.level ?? 'log').toUpperCase().padEnd(5)
      const msg = (log.event_message ?? '').trim()
      console.log(`${ts}  ${level}  ${msg}`)
    }
  }

  // キーワード別の簡易集計
  if (QUERY === 'station_unmapped') {
    const counts = {}
    for (const log of logs) {
      const m = log.event_message?.match(/\[station_unmapped\]\s+(.+)/)
      if (m) counts[m[1].trim()] = (counts[m[1].trim()] ?? 0) + 1
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    if (sorted.length > 0) {
      console.log('\n─'.repeat(70))
      console.log('【未マッピング駅 集計（station_master への INSERT 候補）】')
      sorted.forEach(([s, n]) => console.log(`  ${String(n).padStart(3)}回  ${s}`))
    }
  }

  if (logs.length >= LIMIT) {
    console.log(`\n⚠️  上限(${LIMIT})到達 → --limit ${LIMIT * 2} で増やして再実行`)
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  process.exit(1)
}
