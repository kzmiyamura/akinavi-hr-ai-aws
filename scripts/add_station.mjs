#!/usr/bin/env node
/**
 * add_station.mjs — station_master に駅を追加し、誤都道府県の人材を修正する
 *
 * 使い方:
 *   node scripts/add_station.mjs "川間" "千葉県"
 *   node scripts/add_station.mjs "八千代中央" "千葉県"
 *   node scripts/add_station.mjs "川間" "千葉県" --fix-wrong "岩手県"
 *     → station_master に追加 + 川間駅なのに岩手県になってる候補者を千葉県に修正
 *
 * 環境変数: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY（.env.local から自動読み込み）
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
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

const args = process.argv.slice(2)
const stationName = args[0]
const prefecture = args[1]
const wrongPrefIdx = args.indexOf('--fix-wrong')
const wrongPrefecture = wrongPrefIdx !== -1 ? args[wrongPrefIdx + 1] : null

if (!stationName || !prefecture) {
  console.error('使い方: node scripts/add_station.mjs <駅名> <都道府県> [--fix-wrong <誤都道府県>]')
  console.error('例: node scripts/add_station.mjs "川間" "千葉県" --fix-wrong "岩手県"')
  process.exit(1)
}

async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${text}`)
  return text ? JSON.parse(text) : []
}

// ① station_master に追加（on conflict update）
// ユニーク制約は (name, line, prefecture)。手動追加は路線不明のため line='' で入れる
// （export_station_master.mjs は null/'' を同じく '' 扱いするため整合する）。
console.log(`\n🚉 station_master に追加: "${stationName}" → ${prefecture}`)
try {
  const result = await rest('POST', 'station_master', { name: stationName, line: '', prefecture })
  console.log(`  ✅ 追加/更新完了: ${JSON.stringify(result)}`)
} catch (e) {
  console.error(`  ❌ 追加失敗: ${e.message}`)
  process.exit(1)
}

// ② 誤都道府県の候補者を修正（--fix-wrong 指定時）
if (wrongPrefecture) {
  console.log(`\n🔧 誤都道府県修正: "${stationName}" で ${wrongPrefecture} → ${prefecture}`)
  try {
    // nearest_station が stationName（末尾の「駅」あり/なし両対応）で prefecture が wrongPrefecture の候補者を検索
    const stationWithSuffix = stationName.endsWith('駅') ? stationName : stationName + '駅'
    const stationWithout = stationName.endsWith('駅') ? stationName.slice(0, -1) : stationName

    // raw_profile->>'nearestStation' ILIKE patterns
    const candidates = await rest('GET',
      `candidates?select=id,name,raw_profile&data_env=eq.prod&limit=100`
    )
    const targets = candidates.filter(c => {
      const ns = c.raw_profile?.nearestStation ?? ''
      const pref = c.raw_profile?.prefecture ?? ''
      return (ns.includes(stationWithout)) && pref === wrongPrefecture
    })

    if (targets.length === 0) {
      console.log('  ℹ️  修正対象なし（既に正しい or 該当なし）')
    } else {
      console.log(`  対象: ${targets.length} 件`)
      let fixed = 0
      for (const c of targets) {
        try {
          const newRawProfile = { ...c.raw_profile, prefecture }
          await rest('PATCH', `candidates?id=eq.${c.id}`, { raw_profile: newRawProfile })
          console.log(`  ✅ ${c.id.slice(0, 8)} ${c.name ?? ''}  ${wrongPrefecture} → ${prefecture}`)
          fixed++
        } catch (e2) {
          console.error(`  ❌ ${c.id.slice(0, 8)} 更新失敗: ${e2.message}`)
        }
      }
      console.log(`\n  修正完了: ${fixed}/${targets.length} 件`)
    }
  } catch (e) {
    console.error(`  ❌ 修正クエリ失敗: ${e.message}`)
  }
}

console.log('\n完了 ✅')
console.log('※ 重要: inbound-email は station_master を実行時に問い合わせず、ビルド時同梱の')
console.log('   station_data.json を使う。DBに追加しただけでは反映されない。以下を必ず実行:')
console.log('     node scripts/export_station_master.mjs   # DB → station_data.json 再生成')
console.log('     bash scripts/check-and-deploy-edge.sh inbound-email   # 再デプロイ')
