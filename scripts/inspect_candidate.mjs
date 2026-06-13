#!/usr/bin/env node
/**
 * inspect_candidate.mjs — 候補者の raw_profile JSON を整形表示するスクリプト
 *
 * 使い方:
 *   node scripts/inspect_candidate.mjs <ID or 名前>
 *   node scripts/inspect_candidate.mjs bc3f9ef5-897a-4c62-a931-cd6d6aa4457a
 *   node scripts/inspect_candidate.mjs "D.U"
 *   node scripts/inspect_candidate.mjs "D.U" --key skillSummary
 *   node scripts/inspect_candidate.mjs "D.U" --key skillYears
 *   node scripts/inspect_candidate.mjs "D.U" --key excelData
 *   node scripts/inspect_candidate.mjs "D.U" --keys   # raw_profile のキー一覧だけ表示
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// .env.local 読み込み
const envPath = resolve(__dirname, '../.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim()
  }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

const args = process.argv.slice(2)
const query = args[0]
const keyFlagIdx = args.indexOf('--key')
const targetKey = keyFlagIdx >= 0 ? args[keyFlagIdx + 1] : null
const listKeys = args.includes('--keys')

if (!query) {
  console.log('使い方: node scripts/inspect_candidate.mjs <ID or 名前> [--key <フィールド>] [--keys]')
  process.exit(0)
}

async function fetchCandidate(query) {
  const isUuid = /^[0-9a-f-]{36}$/.test(query)
  const filter = isUuid
    ? `id=eq.${query}`
    : `name=eq.${encodeURIComponent(query)}`

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/candidates?${filter}&select=id,name,skills,experience_years,desired_rate,resume_url,drive_url,created_at,raw_profile&order=created_at.desc&limit=5`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  return res.json()
}

const rows = await fetchCandidate(query)

if (!rows || rows.length === 0) {
  console.log(`「${query}」に一致する候補者が見つかりませんでした`)
  process.exit(0)
}

for (const c of rows) {
  const rp = c.raw_profile ?? {}
  console.log('\n' + '='.repeat(60))
  console.log(`ID:         ${c.id}`)
  console.log(`名前:       ${c.name}`)
  console.log(`スキル数:   ${(c.skills ?? []).length}件`)
  console.log(`経験年数:   ${c.experience_years ?? 'null'}`)
  console.log(`希望単価:   ${c.desired_rate ?? 'null'}`)
  console.log(`resume_url: ${c.resume_url ?? 'null'}`)
  console.log(`drive_url:  ${c.drive_url ?? 'null'}`)
  console.log(`作成日時:   ${c.created_at}`)

  if (listKeys) {
    console.log('\n--- raw_profile キー一覧 ---')
    for (const [k, v] of Object.entries(rp)) {
      const preview = JSON.stringify(v)
      console.log(`  ${k}: ${preview.slice(0, 80)}${preview.length > 80 ? '...' : ''}`)
    }
    continue
  }

  if (targetKey) {
    console.log(`\n--- raw_profile.${targetKey} ---`)
    console.log(JSON.stringify(rp[targetKey], null, 2))
    continue
  }

  // デフォルト: 主要フィールドを表示
  const show = ['skillSummary', 'skillYears', 'prefecture', 'nearestStation',
                'roles', 'industries', 'selfPR', 'agentComment', 'wantsFullRemote']
  console.log('\n--- raw_profile 主要フィールド ---')
  for (const k of show) {
    if (k in rp) {
      const v = JSON.stringify(rp[k])
      console.log(`  ${k}: ${v.slice(0, 120)}${v.length > 120 ? '...' : ''}`)
    }
  }

  console.log(`\n--- スキル一覧 ---`)
  console.log((c.skills ?? []).join(', '))
}
