#!/usr/bin/env node
/**
 * check_extraction.mjs — 直近の抽出取りこぼしを Supabase から確認するスクリプト
 *
 * 使い方:
 *   node scripts/check_extraction.mjs           # 直近 14 日・全チェック
 *   node scripts/check_extraction.mjs --days 7  # 直近 7 日
 *   node scripts/check_extraction.mjs --name    # 名前不明のみ
 *   node scripts/check_extraction.mjs --null    # NULL フィールドのみ
 *   node scripts/check_extraction.mjs --misreg  # 誤登録のみ
 *   node scripts/check_extraction.mjs --projects # 案件の取りこぼし
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

// --- .env.local 読み込み ---
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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

// --- CLI 引数 ---
const args = process.argv.slice(2)
const daysIdx = args.indexOf('--days')
const DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 14 : 14
const showName = args.includes('--name') || args.length === 0 || (!args.includes('--null') && !args.includes('--misreg') && !args.includes('--projects'))
const showNull = args.includes('--null') || args.length === 0 || (!args.includes('--name') && !args.includes('--misreg') && !args.includes('--projects'))
const showMisreg = args.includes('--misreg') || args.length === 0 || (!args.includes('--name') && !args.includes('--null') && !args.includes('--projects'))
const showProjects = args.includes('--projects')

// すべてのオプションなし or --days のみ → 全チェック
const runAll = !args.some(a => ['--name','--null','--misreg','--projects'].includes(a))

// --- Supabase REST API ---
async function query(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) {
    // exec_sql RPC が存在しない場合は別方法を試みる
    const err = await res.text()
    throw new Error(`SQL失敗 (${res.status}): ${err.slice(0, 200)}`)
  }
  return res.json()
}

// exec_sql RPC の代わりに PostgREST フィルターを使う
async function postgrest(path, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'Accept': 'application/json',
      'Prefer': 'count=exact',
    },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`REST失敗 (${res.status}): ${err.slice(0, 200)}`)
  }
  return res.json()
}

function truncate(str, n = 120) {
  if (!str) return '(なし)'
  const s = str.replace(/\n/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function shortDate(iso) {
  return iso ? iso.slice(0, 16).replace('T', ' ') : ''
}

// --- チェック 1: 名前不明 ---
async function checkNameUnknown() {
  console.log(`\n=== ① 名前「不明」の人材 (直近${DAYS}日) ===\n`)
  const since = new Date(Date.now() - DAYS * 86400000).toISOString()
  try {
    const rows = await postgrest('candidates', {
      select: 'id,name,experience_years,created_at,raw_profile',
      'data_env': 'eq.prod',
      'name': 'eq.不明',
      'created_at': `gt.${since}`,
      'order': 'created_at.desc',
      'limit': '20',
    })
    if (!rows.length) { console.log('  異常なし（0件）'); return }
    console.log(`  ${rows.length} 件検出:\n`)
    for (const r of rows) {
      const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
      console.log(`  [${shortDate(r.created_at)}] id=${r.id.slice(0,8)}...`)
      console.log(`    from: ${raw.from ?? '不明'}  subject: ${raw.subject ?? '不明'}`)
      console.log(`    本文先頭: ${truncate(raw.text, 150)}`)
      console.log()
    }
  } catch (e) {
    console.error('  取得失敗:', e.message)
  }
}

// --- チェック 2: NULL フィールド ---
async function checkNullFields() {
  console.log(`\n=== ② 必須フィールド NULL の人材 (直近${DAYS}日) ===\n`)
  const since = new Date(Date.now() - DAYS * 86400000).toISOString()
  try {
    // experience_years IS NULL
    const expNull = await postgrest('candidates', {
      select: 'id,name,created_at,raw_profile',
      'data_env': 'eq.prod',
      'name': 'neq.不明',
      'experience_years': 'is.null',
      'created_at': `gt.${since}`,
      'order': 'created_at.desc',
      'limit': '10',
    })
    if (expNull.length) {
      console.log(`  [経験年数 NULL] ${expNull.length} 件:`)
      for (const r of expNull) {
        const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
        console.log(`    ${r.name} [${shortDate(r.created_at)}]  本文: ${truncate(raw.text, 100)}`)
      }
      console.log()
    }

    // prefecture IS NULL (raw_profile->>'prefecture')
    const allRecent = await postgrest('candidates', {
      select: 'id,name,created_at,raw_profile',
      'data_env': 'eq.prod',
      'name': 'neq.不明',
      'created_at': `gt.${since}`,
      'order': 'created_at.desc',
      'limit': '100',
    })
    const noPref = allRecent.filter(r => {
      const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
      return !raw.prefecture
    })
    const noStation = allRecent.filter(r => {
      const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
      return !raw.nearestStation
    })

    if (noPref.length) {
      console.log(`  [都道府県 NULL] ${noPref.length} 件（上位5件）:`)
      for (const r of noPref.slice(0, 5)) {
        const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
        console.log(`    ${r.name} [${shortDate(r.created_at)}]  本文: ${truncate(raw.text, 100)}`)
      }
      console.log()
    }

    if (noStation.length) {
      console.log(`  [最寄駅 NULL] ${noStation.length} 件（上位5件）:`)
      for (const r of noStation.slice(0, 5)) {
        const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
        console.log(`    ${r.name} [${shortDate(r.created_at)}]  本文: ${truncate(raw.text, 100)}`)
      }
      console.log()
    }

    if (!expNull.length && !noPref.length && !noStation.length) {
      console.log('  異常なし（0件）')
    }
  } catch (e) {
    console.error('  取得失敗:', e.message)
  }
}

// --- チェック 3: 誤登録（案件が人材として登録） ---
async function checkMisregistration() {
  console.log(`\n=== ③ 誤登録疑い（案件が人材に混入） (直近${DAYS}日) ===\n`)
  const since = new Date(Date.now() - DAYS * 86400000).toISOString()
  try {
    const rows = await postgrest('candidates', {
      select: 'id,name,skills,created_at,raw_profile',
      'data_env': 'eq.prod',
      'created_at': `gt.${since}`,
      'order': 'created_at.desc',
      'limit': '100',
    })
    const misreg = rows.filter(r => {
      const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
      const text = (raw.text ?? '').toLowerCase()
      const skills = JSON.stringify(r.skills ?? '').toLowerCase()
      return r.name === '不明'
        || skills.includes('案件')
        || text.includes('必須スキル')
        || text.includes('募集要項')
        || text.includes('【募集')
    })
    if (!misreg.length) { console.log('  異常なし（0件）'); return }
    console.log(`  ${misreg.length} 件検出:`)
    for (const r of misreg.slice(0, 10)) {
      const raw = typeof r.raw_profile === 'string' ? JSON.parse(r.raw_profile) : (r.raw_profile ?? {})
      console.log(`  [${shortDate(r.created_at)}] ${r.name}  from: ${raw.from ?? '不明'}`)
      console.log(`    subject: ${raw.subject ?? '不明'}`)
      console.log(`    本文: ${truncate(raw.text, 120)}`)
      console.log()
    }
  } catch (e) {
    console.error('  取得失敗:', e.message)
  }
}

// --- チェック 4: 案件の取りこぼし ---
async function checkProjects() {
  console.log(`\n=== ④ 案件の取りこぼし (直近${DAYS}日) ===\n`)
  const since = new Date(Date.now() - DAYS * 86400000).toISOString()
  try {
    const rows = await postgrest('projects', {
      select: 'id,title,work_location,budget_min,budget_max,created_at,raw_data',
      'data_env': 'eq.prod',
      'created_at': `gt.${since}`,
      'order': 'created_at.desc',
      'limit': '30',
    })
    const missing = rows.filter(r => !r.work_location || (!r.budget_min && !r.budget_max))
    if (!missing.length) { console.log('  異常なし（0件）'); return }
    console.log(`  ${missing.length} 件（勤務地または単価 NULL）:`)
    for (const r of missing.slice(0, 10)) {
      const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : (r.raw_data ?? {})
      const issues = []
      if (!r.work_location) issues.push('勤務地NULL')
      if (!r.budget_min && !r.budget_max) issues.push('単価NULL')
      console.log(`  [${shortDate(r.created_at)}] ${r.title ?? '(無題)'}  [${issues.join('/')}]`)
      console.log(`    本文: ${truncate(raw.text, 120)}`)
      console.log()
    }
  } catch (e) {
    console.error('  取得失敗:', e.message)
  }
}

// --- main ---
console.log(`直近 ${DAYS} 日の抽出取りこぼしチェック (prod)`)
console.log(`Supabase: ${SUPABASE_URL}`)

if (runAll || showName) await checkNameUnknown()
if (runAll || showNull) await checkNullFields()
if (runAll || showMisreg) await checkMisregistration()
if (showProjects) await checkProjects()

console.log('\n=== チェック完了 ===')
