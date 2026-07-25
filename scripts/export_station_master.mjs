#!/usr/bin/env node
/**
 * export_station_master.mjs — station_master(DB) を JSON に書き出し、
 * supabase/functions/inbound-email/station_data.json に配置する。
 *
 * DBを正としつつ、Edge Function実行時のDB往復（egress・レイテンシ）を無くすため、
 * デプロイ物には静的スナップショットを同梱する（sync_extractors.mjsと同じ思想）。
 * DB更新（scripts/add_station.mjs 等）のたびに本スクリプトを再実行し、
 * check-and-deploy-edge.sh の前に station_data.json を最新化すること。
 *
 * Usage: node scripts/export_station_master.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim()
    if (!process.env[k]) process.env[k] = v
  }
}
loadEnv()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ANON_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です（.env.local を確認）')
  process.exit(1)
}

async function fetchAllStations() {
  const rows = []
  const pageSize = 1000
  let offset = 0
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/station_master?select=name,line,prefecture&order=name.asc&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    )
    if (!res.ok) throw new Error(`station_master fetch failed: ${res.status} ${await res.text()}`)
    const page = await res.json()
    rows.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }
  return rows
}

const rows = await fetchAllStations()
if (rows.length === 0) {
  console.error('ERROR: station_masterが0件でした。中断します（誤って空データを書き出さないため）')
  process.exit(1)
}

// name -> [{line, prefecture}] のマップ。同名駅（府中等）は路線ごとに複数エントリを持つ。
// 路線情報がない行（line=null。旧データ・手動追加分）は line:'' として保持する。
const map = {}
for (const r of rows) {
  const entry = { line: r.line ?? '', prefecture: r.prefecture }
  ;(map[r.name] ??= []).push(entry)
}

const outPath = resolve(ROOT, 'supabase/functions/inbound-email/station_data.json')
writeFileSync(outPath, JSON.stringify(map))
console.log(`✅ station_master ${rows.length}件（${Object.keys(map).length}駅名） → ${outPath} に書き出しました`)
